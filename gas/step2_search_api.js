/**
 * Step2: 商品検索APIエンドポイント
 * GitHub PagesのチャットUIから条件を受け取り、スプレッドシートの商品データを絞り込んで返す
 */

// === メインエンドポイント ===

function doPost(e) {
  var params = parseRequest_(e);
  var products = getProducts_();
  var scored = filterAndScore_(products, params);
  var top5 = scored.slice(0, 5);
  var withReasons = generateReasons_(top5, params);
  var top3 = withReasons.slice(0, 3);
  var result = buildResponse_(top3);
  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function doOptions() {
  return ContentService
    .createTextOutput('')
    .setMimeType(ContentService.MimeType.TEXT);
}

// === リクエスト処理 ===

function parseRequest_(e) {
  var body = {};
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    // パース失敗時はデフォルト値を使用
  }
  return {
    purpose: body.purpose || '',
    budget: parseInt(body.budget, 10) || 0,
    recipient: body.recipient || '',
    category: body.category || '',
    freeword: body.freeword || ''
  };
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

// === 絞り込み＆スコアリング ===

function filterAndScore_(products, params) {
  var scored = [];

  for (var i = 0; i < products.length; i++) {
    var p = products[i];
    if (p.price <= 0) continue;
    if (params.budget > 0 && p.price > params.budget) continue;

    var score = matchProduct_(p, params);
    scored.push({ product: p, score: score });
  }

  scored.sort(function(a, b) { return b.score - a.score; });

  return scored.map(function(s) { return s.product; });
}

function matchProduct_(product, params) {
  var score = 0;
  var tags = (product.tags || '').toLowerCase();
  var name = (product.name || '').toLowerCase();

  // 1. タグに purpose が含まれる → +10点
  if (params.purpose && tags.indexOf(params.purpose.toLowerCase()) >= 0) {
    score += 10;
  }

  // 2. price が budget 以下 → +5点
  if (params.budget > 0 && product.price <= params.budget) {
    score += 5;
  }

  // 3. price が budget の80%以上 → +3点
  if (params.budget > 0 && product.price >= params.budget * 0.8) {
    score += 3;
  }

  // 4. category が指定されていて一致 → +5点
  if (params.category && product.category === params.category) {
    score += 5;
  }

  // 5. freeword が name または tags に含まれる → +3点
  if (params.freeword) {
    var fw = params.freeword.toLowerCase();
    if (name.indexOf(fw) >= 0 || tags.indexOf(fw) >= 0) {
      score += 3;
    }
  }

  return score;
}

// === Claude API連携 ===

function generateReasons_(products, params) {
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
    '以下のお客様の条件と商品情報をもとに、各商品への一言おすすめ理由を日本語で生成してください。\n\n' +
    '【お客様の条件】\n' +
    '- 贈る目的: ' + (params.purpose || '指定なし') + '\n' +
    '- ご予算: ' + (params.budget || '指定なし') + '円\n' +
    '- 贈る相手: ' + (params.recipient || '指定なし') + '\n\n' +
    '【商品リスト】\n' + productList + '\n\n' +
    '各商品について、20〜40文字のおすすめ理由を生成してください。\n' +
    '必ずJSON形式で返してください：\n' +
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
  return {
    status: 'ok',
    total: products.length,
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
