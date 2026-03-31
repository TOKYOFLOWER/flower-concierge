/**
 * Step1: 楽天RMS ItemAPI 2.0 商品データ取得
 *
 * 自店舗(tokyoflower)の全商品をRMS APIで取得し、
 * カテゴリ・用途タグ・価格帯を自動判定してスプレッドシートにキャッシュする。
 *
 * スクリプトプロパティ:
 *   SERVICE_SECRET  - RMS WEB SERVICE serviceSecret
 *   LICENSE_KEY     - RMS WEB SERVICE licenseKey
 *   SPREADSHEET_ID  - 書き込み先スプレッドシートID
 */

// ============================================================
// 定数
// ============================================================

var API_ENDPOINT = 'https://api.rms.rakuten.co.jp/es/2.0/items/search';
var SHOP_CODE = 'tokyoflower';
var PAGE_LIMIT = 100;

var PRODUCTS_SHEET = 'products';
var LOGS_SHEET = 'logs';

var HEADER_ROW = [
  'id', 'source', 'name', 'category', 'price', 'price_range', 'tags',
  'image_url', 'rakuten_url', 'makeshop_url', 'item_code',
  'available', 'last_updated',
];

// カテゴリ判定ルール（上から優先マッチ）
var CATEGORY_RULES = [
  { pattern: /胡蝶蘭|こちょうらん/,                                       label: '胡蝶蘭' },
  { pattern: /スタンド|立て看板/,                                          label: 'スタンド花' },
  { pattern: /観葉|鉢植え|ポトス|モンステラ|パキラ|ガジュマル/,            label: '鉢植え・観葉植物' },
  { pattern: /鉢|ポット|シクラメン|ビオラ|パンジー/,                       label: '花鉢・鉢物' },
  { pattern: /アレンジ|アレンジメント/,                                    label: 'アレンジメント' },
];
var DEFAULT_CATEGORY = '切り花・花束';

// 用途タグ判定ルール
var TAG_RULES = [
  { pattern: /誕生日|バースデー|birthday/i,            tag: '誕生日' },
  { pattern: /開店|開業|開院|移転/,                    tag: '開店祝い' },
  { pattern: /お見舞い|見舞/,                          tag: 'お見舞い' },
  { pattern: /法人|企業|コーポレート/,                 tag: '法人' },
  { pattern: /母の日|Mother/i,                         tag: '母の日' },
  { pattern: /父の日|Father/i,                         tag: '父の日' },
  { pattern: /結婚|ウェディング|ブライダル/,           tag: '結婚祝い' },
  { pattern: /出産|赤ちゃん|ベビー/,                   tag: '出産祝い' },
  { pattern: /就任|昇進|栄転/,                         tag: '就任祝い' },
  { pattern: /お礼|感謝|ありがとう/,                   tag: 'お礼' },
  { pattern: /記念日|アニバーサリー/,                  tag: '記念日' },
  { pattern: /敬老/,                                   tag: '敬老の日' },
  { pattern: /クリスマス|Christmas/i,                  tag: 'クリスマス' },
  { pattern: /バレンタイン/,                           tag: 'バレンタイン' },
  { pattern: /ホワイトデー/,                           tag: 'ホワイトデー' },
  { pattern: /卒業|卒園/,                              tag: '卒業・卒園' },
  { pattern: /入学|入園/,                              tag: '入学・入園' },
  { pattern: /送別|退職|送る/,                         tag: '送別' },
];

// 価格帯ルール
var PRICE_RANGES = [
  { max: 3000,     label: '～3,000円' },
  { max: 5000,     label: '～5,000円' },
  { max: 10000,    label: '～10,000円' },
  { max: 20000,    label: '～20,000円' },
  { max: 30000,    label: '～30,000円' },
  { max: Infinity, label: '30,000円以上' },
];

// ============================================================
// メインエントリ
// ============================================================

/**
 * 全商品を取得してスプレッドシートに書き込む（トリガー設定用）
 */
function fetchAllRakutenProducts() {
  var startTime = new Date();
  var products = [];
  var offset = 0;

  try {
    while (true) {
      var result = fetchPage_(offset, PAGE_LIMIT);
      if (!result || !result.results || result.results.length === 0) break;

      var results = result.results;
      for (var i = 0; i < results.length; i++) {
        products.push(normalizeItem_(results[i].item));
      }

      Logger.log('取得中: offset=' + offset + ', 件数=' + results.length + ', 総件数=' + result.numFound);

      offset += results.length;
      if (offset >= result.numFound) break;
      Utilities.sleep(500);
    }

    writeToSheet_(products);
    var elapsed = ((new Date() - startTime) / 1000).toFixed(1);
    log_(products.length, 'success');
    Logger.log('完了: ' + products.length + '件 (' + elapsed + '秒)');

  } catch (e) {
    log_(products.length, 'error: ' + e.message);
    Logger.log('エラー: ' + e.message);
    throw e;
  }
}

/**
 * テスト用: 最初の10件だけ取得してLogger.logで確認
 */
function testFetch() {
  var result = fetchPage_(0, 10);
  var results = result.results || [];
  Logger.log('取得件数: ' + results.length + ', 総件数: ' + result.numFound);

  for (var i = 0; i < results.length; i++) {
    var p = normalizeItem_(results[i].item);
    Logger.log(JSON.stringify({
      id: p.id,
      name: p.name,
      category: p.category,
      price: p.price,
      price_range: p.price_range,
      tags: p.tags,
    }));
  }
}

// ============================================================
// API取得
// ============================================================

/**
 * ESA認証ヘッダー文字列を返す
 */
function buildAuthHeader_() {
  var secret = getProperty_('SERVICE_SECRET');
  var license = getProperty_('LICENSE_KEY');
  var encoded = Utilities.base64Encode(secret + ':' + license).replace(/\n/g, '');
  return 'ESA ' + encoded;
}

/**
 * 認証ヘッダーのデバッグ用関数
 * GASエディタから手動実行してログを確認する
 */
function debugAuth() {
  var secret = getProperty_('SERVICE_SECRET');
  var license = getProperty_('LICENSE_KEY');
  Logger.log('SERVICE_SECRET length: ' + secret.length);
  Logger.log('LICENSE_KEY length: ' + license.length);
  var encoded = Utilities.base64Encode(secret + ':' + license);
  Logger.log('Base64 encoded: ' + encoded);
  Logger.log('Authorization header: ESA ' + encoded);
}

/**
 * 指定ページのAPIレスポンスを返す
 */
function fetchPage_(offset, limit) {
  var url = API_ENDPOINT
    + '?offset=' + offset
    + '&limit=' + limit
    + '&isHiddenItem=false';

  var options = {
    method: 'get',
    headers: {
      'Authorization': buildAuthHeader_(),
    },
    muteHttpExceptions: true,
  };

  var response = UrlFetchApp.fetch(url, options);
  var code = response.getResponseCode();

  if (code !== 200) {
    throw new Error('API応答エラー: HTTP ' + code + ' - ' + response.getContentText().substring(0, 300));
  }

  return JSON.parse(response.getContentText());
}

// ============================================================
// データ変換
// ============================================================

/**
 * APIレスポンス1件を統一フォーマットに変換
 */
function normalizeItem_(item) {
  var manageNumber = item.manageNumber || '';
  var name = item.title || '';
  var catchcopy = item.tagline || '';
  var text = name + ' ' + catchcopy;
  var imageUrl = (item.images && item.images.imageUrl) ? item.images.imageUrl : '';
  // variantsはオブジェクト形式。全SKUのstandardPriceから最小価格を取得する
  var price = 0;
  if (item.variants) {
    var prices = Object.keys(item.variants).map(function(k) {
      return parseInt(item.variants[k].standardPrice || '0', 10);
    }).filter(function(p) { return p > 0; });
    if (prices.length > 0) {
      price = Math.min.apply(null, prices);
    }
  }

  return {
    id: 'rakuten_' + manageNumber,
    source: 'rakuten',
    name: name,
    category: detectCategory_(text),
    price: price,
    price_range: classifyPrice_(price),
    tags: detectTags_(text),
    image_url: imageUrl,
    rakuten_url: 'https://item.rakuten.co.jp/' + SHOP_CODE + '/' + manageNumber,
    makeshop_url: '',
    item_code: manageNumber,
    available: true,
    last_updated: new Date().toISOString(),
  };
}

/**
 * テキストからカテゴリ名を返す（上から優先マッチ）
 */
function detectCategory_(text) {
  for (var i = 0; i < CATEGORY_RULES.length; i++) {
    if (CATEGORY_RULES[i].pattern.test(text)) {
      return CATEGORY_RULES[i].label;
    }
  }
  return DEFAULT_CATEGORY;
}

/**
 * テキストから用途タグ配列を返す（カンマ区切り文字列）
 */
function detectTags_(text) {
  var tags = [];
  for (var i = 0; i < TAG_RULES.length; i++) {
    if (TAG_RULES[i].pattern.test(text)) {
      tags.push(TAG_RULES[i].tag);
    }
  }
  return tags.join(', ');
}

/**
 * 価格帯文字列を返す
 */
function classifyPrice_(price) {
  for (var i = 0; i < PRICE_RANGES.length; i++) {
    if (price < PRICE_RANGES[i].max) {
      return PRICE_RANGES[i].label;
    }
  }
  return '30,000円以上';
}

// ============================================================
// スプレッドシート書き込み
// ============================================================

/**
 * productsシートを全クリアして書き込み
 */
function writeToSheet_(products) {
  var ss = SpreadsheetApp.openById(getProperty_('SPREADSHEET_ID'));

  var sheet = ss.getSheetByName(PRODUCTS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(PRODUCTS_SHEET);
  }

  sheet.clearContents();
  sheet.getRange(1, 1, 1, HEADER_ROW.length).setValues([HEADER_ROW]);

  if (products.length === 0) return;

  var rows = products.map(function(p) {
    return [
      p.id,
      p.source,
      p.name,
      p.category,
      p.price,
      p.price_range,
      p.tags,
      p.image_url,
      p.rakuten_url,
      p.makeshop_url,
      p.item_code,
      p.available,
      p.last_updated,
    ];
  });

  sheet.getRange(2, 1, rows.length, HEADER_ROW.length).setValues(rows);
  Logger.log('productsシート書き込み完了: ' + rows.length + '件');
}

// ============================================================
// ログ
// ============================================================

/**
 * logsシートに実行日時・件数・ステータスを記録
 */
function log_(count, status) {
  try {
    var ss = SpreadsheetApp.openById(getProperty_('SPREADSHEET_ID'));
    var sheet = ss.getSheetByName(LOGS_SHEET);
    if (!sheet) {
      sheet = ss.insertSheet(LOGS_SHEET);
      sheet.getRange(1, 1, 1, 3).setValues([['timestamp', 'count', 'status']]);
    }
    sheet.appendRow([new Date().toISOString(), count, status]);
  } catch (e) {
    Logger.log('ログ書き込み失敗: ' + e.message);
  }
}

// ============================================================
// ユーティリティ
// ============================================================

/**
 * スクリプトプロパティを取得
 */
function getProperty_(key) {
  var value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value) {
    throw new Error('スクリプトプロパティ "' + key + '" が未設定です');
  }
  return value;
}

function priceDebugTest() {
  var url = 'https://api.rms.rakuten.co.jp/es/2.0/items/search?limit=1&offset=0';
  var options = {
    method: 'GET',
    headers: { 'Authorization': buildAuthHeader_() },
    muteHttpExceptions: true
  };
  var res = UrlFetchApp.fetch(url, options);
  var data = JSON.parse(res.getContentText());
  var item = data.results[0].item;
  Logger.log('variants: ' + JSON.stringify(item.variants));
  Logger.log('price関連キー: ' + JSON.stringify(Object.keys(item).filter(function(k){ return k.toLowerCase().includes('price'); })));
}

function rawResponseTest() {
  var url = 'https://api.rms.rakuten.co.jp/es/2.0/items/search?limit=1&offset=0';
  var options = {
    method: 'GET',
    headers: { 'Authorization': buildAuthHeader_() },
    muteHttpExceptions: true
  };
  var res = UrlFetchApp.fetch(url, options);
  Logger.log('Status: ' + res.getResponseCode());
  Logger.log('Body: ' + res.getContentText());
}
