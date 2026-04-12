#!/usr/bin/env python3
"""
爬取中央社國際新聞，建立人名/國家名 中英對照資料庫
輸出：static/data/names_db.json

用法：
  python scripts/scrape_cna_names.py          # 爬取近兩年
  python scripts/scrape_cna_names.py --days 30 # 只爬最近 30 天（快速更新）
"""

import re
import json
import time
import random
import argparse
import logging
from datetime import datetime, timedelta
from pathlib import Path

import requests
from bs4 import BeautifulSoup

# ── 設定 ──────────────────────────────────────────────
BASE_URL = "https://www.cna.com.tw"
LIST_URL = f"{BASE_URL}/list/aopl.aspx"
OUTPUT_PATH = Path(__file__).parent.parent / "static" / "data" / "names_db.json"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "zh-TW,zh;q=0.9",
    "Referer": BASE_URL,
}

# 找到「任意長度中文 + 全形括號 + 英文 + 全形括號」的完整 pattern
# 後面再用程式邏輯取「最貼近括號」的 2-4 字候選
BRACKET_PATTERN = re.compile(
    r'([\u4e00-\u9fff]+)（([A-Za-z][A-Za-z\s\.\-\']{1,40})）'
)

# 不可能是人名/地名開頭的字（職稱、助詞、介詞、時間詞等）
NON_NAME_START = set('的是在都書員長統于於即其此因年月日今當等後與及以對從自向被由曾已將')

# 過濾掉明顯不是人名/國家名的英文縮寫
SKIP_PATTERNS = re.compile(
    r'^(GDP|NATO|WHO|WTO|IMF|EU|UN|AI|G7|G20|COVID|LGBTQ|NGO|CEO|FBI|CIA|'
    r'BBC|CNN|NYT|AFP|AP|EPA|NFL|NBA|MLB|GPT|API|SDK|AUM|CPR|LNG|AIS|ECMWF|'
    r'IRGC|IEA|IATA|SEMI|NASA|CMA|AUM|deep|Force)$',
    re.IGNORECASE
)

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger(__name__)


def fetch(url: str, retries: int = 3) -> str | None:
    """帶重試的 HTTP GET，失敗回傳 None"""
    for attempt in range(retries):
        try:
            resp = requests.get(url, headers=HEADERS, timeout=15)
            if resp.status_code == 200:
                resp.encoding = 'utf-8'
                return resp.text
            if resp.status_code == 404:
                return None
            log.warning(f"HTTP {resp.status_code}: {url}")
        except requests.RequestException as e:
            log.warning(f"請求失敗（第{attempt+1}次）：{e}")
        time.sleep(2 ** attempt)
    return None


def get_article_urls_from_list_page() -> list[str]:
    """從列表頁的 JSON-LD 取得最新 20 篇的 URL"""
    html = fetch(LIST_URL)
    if not html:
        return []
    soup = BeautifulSoup(html, 'html.parser')
    urls = []
    for script in soup.find_all('script', type='application/ld+json'):
        try:
            data = json.loads(script.string)
            if data.get('@type') == 'ItemList':
                for item in data.get('itemListElement', []):
                    u = item.get('url', '')
                    if '/aopl/' in u:
                        urls.append(u)
        except (json.JSONDecodeError, AttributeError):
            pass
    return urls


def build_date_urls(start_date: datetime, end_date: datetime) -> list[str]:
    """
    根據日期範圍構建文章 URL 列表。
    策略：每天嘗試 0001~0150，遇到連續 5 個 404 就停止當天。
    回傳的是「日期+起始序號」的 seed URL，實際在爬取時再探索。
    """
    urls = []
    current = start_date
    while current <= end_date:
        date_str = current.strftime('%Y%m%d')
        # 每天從 0001 開始，最多試到 0150
        for i in range(1, 151):
            urls.append(f"{BASE_URL}/news/aopl/{date_str}{i:04d}.aspx")
        current += timedelta(days=1)
    return urls


def extract_names_from_html(html: str) -> list[tuple[str, str]]:
    """從文章 HTML 抽出所有「中文名（英文名）」對"""
    # 優先從 JSON-LD articleBody 取文字（更乾淨）
    text = ''
    soup = BeautifulSoup(html, 'html.parser')
    for script in soup.find_all('script', type='application/ld+json'):
        try:
            data = json.loads(script.string)
            # CNA 的 JSON-LD 是 list 格式
            items = data if isinstance(data, list) else [data]
            for item in items:
                if isinstance(item, dict) and item.get('@type') == 'NewsArticle':
                    body = item.get('articleBody', '')
                    if body:
                        text = body
                        break
            if text:
                break
        except (json.JSONDecodeError, AttributeError):
            pass

    # 備援：直接抓 body 文字
    if not text:
        text = soup.get_text()

    pairs = []
    seen = set()
    for m in BRACKET_PATTERN.finditer(text):
        zh_full = m.group(1)  # 括號前的完整中文字串（可能含職稱）
        en = m.group(2).strip()
        if SKIP_PATTERNS.match(en) or len(en) < 3:
            continue
        # 從尾巴往前取候選名稱：
        # - 若括號前中文剛好 ≤2 字（如「川普（Donald Trump）」），直接保留
        # - 否則只取 3-4 字候選，避免「時報」「海峽」等通用 2 字詞汙染
        min_len = 2 if len(zh_full) <= 2 else 3
        for length in range(min_len, min(5, len(zh_full) + 1)):
            zh = zh_full[-length:]
            # 跳過以非人名字元開頭的片段
            if zh[0] in NON_NAME_START:
                continue
            key = (zh, en)
            if key not in seen:
                seen.add(key)
                pairs.append((zh, en))
    return pairs


def scrape(days: int = 730) -> dict[str, str]:
    """
    主爬取流程。
    回傳格式：{ "澤倫斯基": "Volodymyr Zelenskyy", ... }
    """
    end_date = datetime.today()
    start_date = end_date - timedelta(days=days)

    log.info(f"爬取範圍：{start_date.date()} ～ {end_date.date()}（{days} 天）")

    names: dict[str, str] = {}

    # 先用列表頁抓今天最新的
    log.info("從列表頁取得最新文章...")
    latest_urls = get_article_urls_from_list_page()
    log.info(f"列表頁取得 {len(latest_urls)} 篇")

    # 建立日期範圍 URL 清單
    log.info("建立日期範圍 URL 清單...")
    date_urls = build_date_urls(start_date, end_date)
    log.info(f"日期範圍 URL 共 {len(date_urls)} 個候選")

    all_urls = latest_urls + date_urls

    # 去重
    all_urls = list(dict.fromkeys(all_urls))

    # 每天的連續 404 計數（用來提早終止當天）
    consecutive_404: dict[str, int] = {}
    processed = 0
    skipped = 0
    found_pairs = 0

    for url in all_urls:
        # 從 URL 取日期前綴，用來追蹤該天 404 次數
        m = re.search(r'/(\d{8})\d{4}\.aspx', url)
        date_key = m.group(1) if m else 'unknown'

        # 若該天已連續 404 超過 5 次，跳過
        if consecutive_404.get(date_key, 0) >= 5:
            skipped += 1
            continue

        html = fetch(url)
        if html is None:
            consecutive_404[date_key] = consecutive_404.get(date_key, 0) + 1
            skipped += 1
            continue

        # 成功取得，重置該天計數
        consecutive_404[date_key] = 0
        processed += 1

        pairs = extract_names_from_html(html)
        for zh, en in pairs:
            if zh not in names:
                names[zh] = en
                found_pairs += 1

        if processed % 50 == 0:
            log.info(f"已處理 {processed} 篇，已找到 {len(names)} 個名字對，跳過 {skipped} 個 URL")

        # 禮貌性延遲，避免對伺服器造成過大壓力
        time.sleep(random.uniform(0.3, 0.8))

    log.info(f"爬取完成：處理 {processed} 篇，找到 {len(names)} 個名字對")
    return names


def load_existing() -> dict:
    """載入已有的資料庫（增量更新用）"""
    if OUTPUT_PATH.exists():
        try:
            with open(OUTPUT_PATH, 'r', encoding='utf-8') as f:
                data = json.load(f)
                return data.get('names', {})
        except (json.JSONDecodeError, KeyError):
            pass
    return {}


def save(names: dict[str, str]):
    """儲存成 JSON"""
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    output = {
        "updated": datetime.today().strftime('%Y-%m-%d'),
        "count": len(names),
        "names": names
    }
    with open(OUTPUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    log.info(f"已儲存 {len(names)} 筆到 {OUTPUT_PATH}")


def main():
    parser = argparse.ArgumentParser(description='爬取中央社名字資料庫')
    parser.add_argument('--days', type=int, default=730, help='往前爬幾天（預設 730 = 兩年）')
    parser.add_argument('--incremental', action='store_true', help='增量更新（保留舊資料）')
    args = parser.parse_args()

    names = {}
    if args.incremental:
        names = load_existing()
        log.info(f"載入現有 {len(names)} 筆，開始增量更新...")

    new_names = scrape(days=args.days)
    names.update(new_names)  # 新的覆蓋舊的（CNA 譯名可能更新）
    save(names)


if __name__ == '__main__':
    main()
