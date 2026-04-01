/**
 * Step2: 商品検索APIエンドポイント
 * GitHub PagesのチャットUIから条件を受け取り、スプレッドシートの商品データを絞り込んで返す
 */

// === メインエンドポイント ===

function doGet(e) {
  var purpose = e.parameter.purpose || '';
  var budget = parseInt(e.parameter.budget || '99999', 10);
  var recipient = e.parameter.recipient || '';
  var category = e.parameter.category || '';
  var freeword = e.parameter.freeword || '';

  var params = {
    purpose: purpose,
    budget: budget,
    recipient: recipient,
    category: category,
    freeword: freeword
  };

  var excludeRules = getExcludeRulesFromSheet_();
  var boostRules = getBoostRulesFromSheet_();
  var pinnedProducts = getPinnedProductsFromSheet_(params.purpose, params.budget);
  var promptHint = getPromptHintFromSheet_(params.purpose);

  var products = getProducts_();
  var scored = filterAndScore_(products, params, excludeRules, boostRules);

  // 結果0件の場合はカテゴリ条件を外して再検索
  if (scored.length === 0 && params.category) {
    var relaxedParams = { purpose: params.purpose, budget: params.budget, recipient: params.recipient, category: '', freeword: params.freeword };
    scored = filterAndScore_(getProducts_(), relaxedParams, excludeRules, boostRules);
  }

  var top6 = scored.slice(0, 6);
  var withReasons = generateReasons_(top6, params, promptHint);

  // pinnedProductsを先頭に挿入して上限3件
  var top3;
  if (pinnedProducts.length > 0) {
    var pinnedIds = pinnedProducts.map(function(p) { return p.id; });
    var filtered = withReasons.filter(function(p) { return pinnedIds.indexOf(p.id) === -1; });
    top3 = pinnedProducts.concat(filtered).slice(0, 3);
  } else {
    top3 = withReasons.slice(0, 3);
  }

  // top3に含まれない商品をextra_productsとして追加
  var extraProducts = withReasons.filter(function(p) {
    return top3.every(function(t) { return t.id !== p.id; });
  }).slice(0, 3);

  var result = buildResponseWithExtra_(top3, extraProducts);
  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// === スプレッドシートから商品取得 ===

function getProducts_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('products');
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var products = [];

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    products.push({
      id: row[0],
      source: row[1],
      name: row[2],
      category: row[3],
      price: parseInt(row[4], 10) || 0,
      price_range: row[5],
      tags: row[6],
      image_url: row[7],
      rakuten_url: row[8],
      makeshop_url: row[9],
      item_code: row[10],
      available: row[11],
      last_updated: row[12]
    });
  }
  return products;
}

// === ネガティブフィルタ ===

var NEGATIVE_RULES = [
  // お供え・仏事系を慶事から除外
  { purpose: ['誕生日','記念日','開店祝い','結婚祝い','就任祝い','母の日','父の日','出産祝い'],
    excludeTags: ['お供え','仏事','法要','お彼岸'],
    excludeKeywords: ['お供え','供花','仏','法要','お彼岸','四十九日','命日','弔','お悔やみ','osonae','bouqet1'] },

  // 鉢物・観葉をお見舞いから除外
  { purpose: ['お見舞い'],
    excludeCategories: ['鉢植え・観葉植物','花鉢・鉢物','スタンド花'],
    excludeKeywords: ['鉢','ポット','プランター'] },

  // 資材・肥料・道具類を全用途から除外
  { purpose: ['誕生日','記念日','開店祝い','お見舞い','結婚祝い','就任祝い','母の日','父の日','出産祝い','自宅用'],
    excludeKeywords: ['肥料','農薬','スプレー','オアシス','フローラ','資材','ネコポス','プランター用','吸水','スポンジ','苗','種','球根',
                      'アクアフォーム','AQUAFOAM','クリザール','chrysal','フラワーフード',
                      '鮮度保持剤','活力剤','栄養剤','水揚げ',
                      '盆栽','栽培セット','栽培キット','種まき','育てる',
                      'ラッピング用','包装','セロファン','リボン単品',
                      'ハーバリウムオイル','ハーバリウム用','オイル 1L','オイル 500ml',
                      'エタノール','アルコール','消毒','除菌','パストリーゼ','ヘリオス','飲用不可'] },

  // 単品注文不可商品を除外
  { purpose: ['誕生日','記念日','開店祝い','お見舞い','結婚祝い','就任祝い','母の日','父の日','出産祝い'],
    excludeKeywords: ['単品でのご注文はできません','単品不可','オプション'] },

  // 造花・フェイク系・シャボン等を全用途から除外
  { purpose: ['誕生日','記念日','開店祝い','お見舞い','結婚祝い','就任祝い','母の日','父の日','出産祝い','自宅用'],
    excludeKeywords: ['シャボン','ソープフラワー','造花','アーティフィシャル','フェイク','ドライフラワー'] },

  // 刃物を全ギフト用途から除外（「縁を切る」を連想）
  { purpose: ['誕生日','記念日','開店祝い','お見舞い','結婚祝い','就任祝い','母の日','父の日','出産祝い'],
    excludeKeywords: ['ナイフ','包丁','はさみ','ハサミ','鋏','カッター','刃'] },

  // 酒類を出産祝い・お見舞いから除外
  { purpose: ['出産祝い','お見舞い'],
    excludeKeywords: ['ワイン','シャンパン','スパークリング','日本酒','焼酎','ビール','酒','リキュール','フェリスタス'] }
];

function applyNegativeFilter_(products, purpose) {
  return products.filter(function(p) {
    var nameAndTags = (p.name + ' ' + p.tags).toLowerCase();
    for (var i = 0; i < NEGATIVE_RULES.length; i++) {
      var rule = NEGATIVE_RULES[i];
      if (rule.purpose.indexOf(purpose) === -1) continue;
      // キーワード除外
      if (rule.excludeKeywords) {
        for (var j = 0; j < rule.excludeKeywords.length; j++) {
          if (nameAndTags.indexOf(rule.excludeKeywords[j].toLowerCase()) !== -1) return false;
          if (p.id && p.id.indexOf(rule.excludeKeywords[j].toLowerCase()) !== -1) return false;
        }
      }
      // カテゴリ除外
      if (rule.excludeCategories) {
        if (rule.excludeCategories.indexOf(p.category) !== -1) return false;
      }
    }
    return true;
  });
}

// === 花商品ホワイトリストフィルタ ===

var FLOWER_WHITELIST = [
  '花束', 'ブーケ', 'フラワー', 'アレンジ', 'アレンジメント',
  'バラ', '薔薇', 'ローズ', 'rose',
  'ユリ', '百合', 'ゆり',
  'カーネーション', 'チューリップ',
  'ひまわり', '向日葵',
  '胡蝶蘭', 'こちょうらん',
  'スタンド花', 'スタンドフラワー',
  '観葉植物', '観葉',
  '鉢植え', '鉢物', '花鉢',
  'プリザーブドフラワー',
  '季節の花', '生花', '切り花',
  'スイートピー', 'ガーベラ', 'アジサイ', 'あじさい',
  'ダリア', 'リンドウ', 'コスモス',
  'シクラメン', 'ポインセチア',
  'グリーン', 'ボタニカル',
  '花とワイン', 'ワインと花', '花セット'
];

var FLOWER_CATEGORIES = [
  '切り花・花束', 'アレンジメント', '鉢植え・観葉植物',
  '花鉢・鉢物', 'スタンド花', '胡蝶蘭'
];

var NON_FLOWER_BLACKLIST = [
  'ナイフ', '包丁', 'はさみ', 'ハサミ', '鋏',
  'ワイン', 'シャンパン', 'スパークリング', 'フェリスタス',
  '日本酒', '焼酎', 'ビール', 'リキュール',
  'ぬいぐるみ', 'ストラップ', 'キーホルダー',
  'マグカップ', 'タオル', 'ハンカチ',
  'チョコレート', 'クッキー', 'お菓子',
  'キャンドル', 'アロマ', '入浴剤', 'バスソルト',
  'クリザール', 'chrysal', 'フラワーフード', '鮮度保持剤', '活力剤',
  'アクアフォーム', 'AQUAFOAM',
  'ハーバリウムオイル', 'オイル 1L',
  '栽培セット', '栽培キット', '盆栽',
  'エタノール', 'アルコール', '消毒', '除菌', 'パストリーゼ', 'ヘリオス',
  'スピリッツ', '飲用不可'
];

function isFlowerProduct_(product) {
  var name = (product.name || '').toLowerCase();

  // ブラックリストに該当したら花商品ではない
  var isBlacklisted = NON_FLOWER_BLACKLIST.some(function(kw) {
    return name.indexOf(kw.toLowerCase()) !== -1;
  });
  if (isBlacklisted) return false;

  // カテゴリが花系ならOK
  if (FLOWER_CATEGORIES.indexOf(product.category) !== -1) return true;

  // 商品名にホワイトリストキーワードが含まれるならOK
  return FLOWER_WHITELIST.some(function(kw) {
    return name.indexOf(kw.toLowerCase()) !== -1;
  });
}

// === 絞り込み＆スコアリング ===

function filterAndScore_(products, params, excludeRules, boostRules) {
  products = applyNegativeFilter_(products, params.purpose || '');
  products = applyDynamicExclude_(products, params.purpose || '', excludeRules || []);
  products = products.filter(function(p) { return isFlowerProduct_(p); });
  var scored = [];

  for (var i = 0; i < products.length; i++) {
    var p = products[i];
    if (p.price <= 0) continue;

    var score = matchProduct_(p, params);
    score += applyDynamicBoost_(p, params.purpose || '', boostRules || []);
    scored.push({ product: p, score: score });
  }

  scored.sort(function(a, b) { return b.score - a.score; });

  return scored.map(function(s) { return s.product; });
}

function matchProduct_(product, params) {
  var score = 0;
  var name = (product.name || '').toLowerCase();
  var tags = (product.tags || '').toLowerCase();
  var category = product.category || '';
  var price = parseInt(product.price, 10) || 0;
  var budget = parseInt(params.budget, 10) || 99999;
  var purpose = (params.purpose || '').toLowerCase();
  var recipient = (params.recipient || '').toLowerCase();
  var reqCategory = (params.category || '').toLowerCase();

  // 1. タグが purpose と完全一致 → 高得点
  if (tags.indexOf(purpose) !== -1) score += 15;

  // 2. 商品名に purpose が含まれる → 追加ポイント
  if (name.indexOf(purpose) !== -1) score += 8;

  // 3. 予算別の価格範囲フィルタ
  var minPrice = 0;
  var maxPrice = 999999;
  if (budget <= 3500)       { minPrice = 2000;  maxPrice = 4500; }
  else if (budget <= 5500)  { minPrice = 3500;  maxPrice = 8000; }
  else if (budget <= 10000) { minPrice = 6000;  maxPrice = 15000; }
  else if (budget <= 20000) { minPrice = 12000; maxPrice = 28000; }
  else                      { minPrice = 18000; maxPrice = 999999; }

  if (price < minPrice || price > maxPrice) return -999;

  // 4. 予算内
  if (price > 0 && price <= budget) score += 5;

  // 5. 予算の80〜100%（適切な価格帯を優遇）
  if (price >= budget * 0.8 && price <= budget) score += 5;

  // 6. カテゴリ一致
  var categoryMap = {
    '花束・切り花': '切り花・花束',
    'アレンジメント': 'アレンジメント',
    '鉢植え・観葉植物': '鉢植え・観葉植物',
    '胡蝶蘭': '胡蝶蘭',
    'スタンド花': 'スタンド花',
    'おまかせ': ''
  };
  var mappedCategory = categoryMap[params.category] || '';
  if (mappedCategory && category === mappedCategory) score += 10;

  // 7. recipient が商品名・タグに含まれる
  var recipientKeywords = {
    '恋人・パートナー': ['恋人','パートナー','プロポーズ','記念日'],
    '家族': ['母','父','家族','ママ','パパ'],
    '友人・知人': ['友人','友達','プレゼント'],
    '職場の方・上司': ['職場','上司','昇進','栄転'],
    'お客様・取引先': ['法人','取引先','開店','開業'],
    '自分用': ['自宅','インテリア','自分用']
  };
  var keywords = recipientKeywords[params.recipient] || [];
  keywords.forEach(function(kw) {
    if (name.indexOf(kw) !== -1 || tags.indexOf(kw) !== -1) score += 3;
  });

  // 8. 画像あり優遇
  if (product.image_url) score += 2;

  // 9. 価格0円は除外
  if (price === 0) score = -999;

  // 10. 花メイン商品ボーナス（カテゴリが花系 → 主力商品として優遇）
  if (FLOWER_CATEGORIES.indexOf(category) !== -1) {
    score += 5;
  }

  // 11. 商品名の先頭が花キーワードで始まる場合（花がメインの商品）
  var flowerFirst = ['花束','ブーケ','アレンジ','バラ','薔薇','ローズ','胡蝶蘭',
                     'ユリ','百合','カーネーション','ひまわり','スタンド花','観葉植物'];
  var isFlowerMain = flowerFirst.some(function(kw) {
    return name.indexOf(kw.toLowerCase()) < 5 && name.indexOf(kw.toLowerCase()) !== -1;
  });
  if (isFlowerMain) score += 5;

  // 12. 用途×カテゴリ適合ボーナス
  var purposeCategoryFit = {
    '出産祝い':   { '切り花・花束': 8, 'アレンジメント': 10, '花鉢・鉢物': 3 },
    '結婚祝い':   { '切り花・花束': 8, 'アレンジメント': 10, '胡蝶蘭': 5 },
    '開店祝い':   { 'スタンド花': 10, '胡蝶蘭': 8, 'アレンジメント': 5 },
    '就任祝い':   { '胡蝶蘭': 10, 'スタンド花': 8, 'アレンジメント': 5 },
    'お見舞い':    { '切り花・花束': 10, 'アレンジメント': 8 },
    '誕生日':     { '切り花・花束': 8, 'アレンジメント': 8, '花鉢・鉢物': 5 },
    '母の日':     { '切り花・花束': 8, 'アレンジメント': 10, '花鉢・鉢物': 8 },
    '父の日':     { '鉢植え・観葉植物': 8, '切り花・花束': 5 },
    '記念日':     { '切り花・花束': 10, 'アレンジメント': 8 },
    '自宅用':     { '切り花・花束': 5, '鉢植え・観葉植物': 10, '花鉢・鉢物': 8 }
  };
  var fitMap = purposeCategoryFit[params.purpose] || {};
  if (fitMap[category]) {
    score += fitMap[category];
  }

  // 13. 資材・消耗品の特徴がある場合は大幅減点
  var materialKeywords = ['小袋','ケース','入り','個入','1L','500ml',
                          '栽培','セット内容','詰め替え','業務用'];
  var materialCount = 0;
  materialKeywords.forEach(function(kw) {
    if (name.indexOf(kw.toLowerCase()) !== -1) materialCount++;
  });
  if (materialCount >= 2) score -= 20;

  return score;
}

// === Claude API連携 ===

function generateReasons_(products, params, promptHint) {
  var apiKey = '';
  try {
    apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY') || '';
  } catch (e) {
    // プロパティ取得失敗
  }

  if (!apiKey || products.length === 0) {
    return products.map(function(p) {
      p.reason = '銀座東京フラワーおすすめの一品です';
      return p;
    });
  }

  var productList = products.map(function(p, i) {
    return (i + 1) + '. ' + p.name + '（' + p.price + '円）';
  }).join('\n');

  var prompt = 'あなたは銀座東京フラワーのフラワーコンシェルジュです。\n' +
    '以下のお客様の条件に最適なお花を提案してください。\n\n' +
    '【お客様の条件】\n' +
    '- 贈る目的: ' + params.purpose + '\n' +
    '- 贈る相手: ' + params.recipient + '\n' +
    '- ご予算: ' + params.budget + '円以内\n\n' +
    '【商品リスト】\n' + productList + '\n\n' +
    '各商品について、以下のルールで20〜40文字のおすすめ理由を生成してください：\n' +
    '- 必ず「' + params.purpose + '」の用途に合った理由にする\n' +
    '- 商品の特徴（色・形・高級感など）を具体的に述べる\n' +
    '- 「お供え」「仏事」など用途と関係ない言葉は使わない\n' +
    '- もし商品が用途に合わない場合は「この商品は' + params.purpose + 'には不向きです」ではなく、良い面を探して提案する\n' +
    (promptHint ? '- 追加指示: ' + promptHint + '\n' : '') +
    '必ずJSON形式のみで返してください（他のテキスト不要）：\n' +
    '{"reasons": ["理由1", "理由2", "理由3"]}';

  try {
    var payload = {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }]
    };

    var options = {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };

    var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', options);
    var resData = JSON.parse(res.getContentText());
    var text = resData.content[0].text;

    // JSONブロックを抽出
    var jsonMatch = text.match(/\{[\s\S]*"reasons"[\s\S]*\}/);
    if (jsonMatch) {
      var reasons = JSON.parse(jsonMatch[0]).reasons;
      for (var i = 0; i < products.length; i++) {
        products[i].reason = (reasons[i] || '銀座東京フラワーおすすめの一品です');
      }
      return products;
    }
  } catch (e) {
    Logger.log('Claude API error: ' + e.message);
  }

  return products.map(function(p) {
    p.reason = '銀座東京フラワーおすすめの一品です';
    return p;
  });
}

// === レスポンス構築 ===

function buildResponse_(products) {
  var hasNonFlower = products.some(function(p) { return !isFlowerProduct_(p); });
  return {
    status: 'ok',
    total: products.length,
    has_non_flower: hasNonFlower,
    products: products.map(function(p) {
      return {
        id: p.id,
        name: p.name,
        category: p.category,
        price: p.price,
        price_range: p.price_range,
        tags: p.tags,
        image_url: p.image_url,
        rakuten_url: p.rakuten_url,
        reason: p.reason || ''
      };
    })
  };
}

function buildResponseWithExtra_(products, extraProducts) {
  var formatProduct = function(p) {
    return {
      id: p.id,
      name: p.name,
      category: p.category,
      price: p.price,
      price_range: p.price_range,
      tags: p.tags,
      image_url: p.image_url,
      rakuten_url: p.rakuten_url,
      reason: p.reason || ''
    };
  };

  return {
    status: 'ok',
    total: products.length + extraProducts.length,
    products: products.map(formatProduct),
    extra_products: extraProducts.map(formatProduct)
  };
}

// === 動的ルール読み込み ===

function getExcludeRulesFromSheet_() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('exclude_rules');
    if (!sheet) return [];
    var data = sheet.getDataRange().getValues();
    var rules = [];
    for (var i = 1; i < data.length; i++) {
      rules.push({
        purpose: String(data[i][1] || ''),
        keywords: String(data[i][2] || '')
      });
    }
    return rules;
  } catch (e) { return []; }
}

function applyDynamicExclude_(products, purpose, rules) {
  if (!rules || rules.length === 0) return products;
  return products.filter(function(p) {
    var nameAndTags = (p.name + ' ' + p.tags + ' ' + (p.id || '')).toLowerCase();
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      if (rule.purpose !== '全用途共通' && rule.purpose !== purpose) continue;
      var keywords = rule.keywords.split(',');
      for (var j = 0; j < keywords.length; j++) {
        var kw = keywords[j].trim().toLowerCase();
        if (kw && nameAndTags.indexOf(kw) !== -1) return false;
      }
    }
    return true;
  });
}

function getBoostRulesFromSheet_() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('boost_rules');
    if (!sheet) return [];
    var data = sheet.getDataRange().getValues();
    var rules = [];
    for (var i = 1; i < data.length; i++) {
      rules.push({
        purpose: String(data[i][1] || ''),
        category: String(data[i][2] || ''),
        score: parseInt(data[i][3], 10) || 10
      });
    }
    return rules;
  } catch (e) { return []; }
}

function applyDynamicBoost_(product, purpose, rules) {
  var bonus = 0;
  for (var i = 0; i < rules.length; i++) {
    var rule = rules[i];
    if (rule.purpose !== '全用途共通' && rule.purpose !== purpose) continue;
    if (product.category === rule.category) {
      bonus += rule.score;
    }
  }
  return bonus;
}

function getPinnedProductsFromSheet_(purpose, budget) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('pinned_products');
    if (!sheet) return [];
    var data = sheet.getDataRange().getValues();
    var pinned = [];
    for (var i = 1; i < data.length; i++) {
      var rowPurpose = String(data[i][1] || '');
      var budgetMax = parseInt(data[i][2], 10) || 0;
      var productId = String(data[i][3] || '');
      var priority = String(data[i][5] || '中');

      if (rowPurpose !== '全用途共通' && rowPurpose !== purpose) continue;
      if (budgetMax > 0 && budget < budgetMax) continue;

      pinned.push({ id: productId, priority: priority });
    }

    // 優先度でソート
    var priorityOrder = { '最優先': 0, '高': 1, '中': 2 };
    pinned.sort(function(a, b) {
      return (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2);
    });

    // productsシートから該当商品を取得
    var products = getProducts_();
    var result = [];
    for (var j = 0; j < pinned.length; j++) {
      for (var k = 0; k < products.length; k++) {
        if (products[k].id === pinned[j].id) {
          products[k].reason = '銀座東京フラワーおすすめの一品です';
          result.push(products[k]);
          break;
        }
      }
    }
    return result;
  } catch (e) { return []; }
}

function getPromptHintFromSheet_(purpose) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('prompt_hints');
    if (!sheet) return '';
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][1] || '') === purpose) {
        return String(data[i][2] || '');
      }
    }
    return '';
  } catch (e) { return ''; }
}

// === テスト用 ===

function testSearch() {
  var mockParams = {
    purpose: '誕生日',
    budget: 10000,
    recipient: '女性',
    category: '',
    freeword: ''
  };
  var products = getProducts_();
  Logger.log('全商品数: ' + products.length);
  var filtered = filterAndScore_(products, mockParams);
  Logger.log('絞り込み結果: ' + filtered.length + '件');
  Logger.log(JSON.stringify(filtered.slice(0, 3), null, 2));
}

function debugProductCategory() {
  var ss = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID'));
  var sheet = ss.getSheetByName('products');
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var nameIdx = headers.indexOf('name');
  var catIdx = headers.indexOf('category');

  var targets = ['フェリスタス', 'フローリストナイフ', 'ハーバリウム'];
  targets.forEach(function(t) {
    for (var i = 1; i < data.length; i++) {
      if (data[i][nameIdx] && data[i][nameIdx].indexOf(t) !== -1) {
        Logger.log(t + ' → カテゴリ: ' + data[i][catIdx]);
        break;
      }
    }
  });
}

function testBabyGift() {
  var params = {
    purpose: '出産祝い',
    budget: 3000,
    recipient: '友人・知人',
    category: '',
    freeword: ''
  };
  var excludeRules = getExcludeRulesFromSheet_();
  var boostRules = getBoostRulesFromSheet_();
  var products = getProducts_();
  var scored = filterAndScore_(products, params, excludeRules, boostRules);

  Logger.log('=== 出産祝い 3000円 結果 ===');
  Logger.log('件数: ' + scored.length);
  scored.slice(0, 5).forEach(function(p, i) {
    Logger.log((i+1) + '. ' + p.name + ' (' + p.price + '円) [' + p.category + ']');
  });
}
