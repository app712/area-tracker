// =====================================================================
// 【設定変数】※スクリプトプロパティから読み込みます（コードに直接書かないでください）
// 設定方法: Apps Scriptエディタ左側の「プロジェクトの設定」(⚙アイコン)
//          →「スクリプト プロパティ」→「スクリプト プロパティを追加」で
//          以下4つのキー名を登録してください。
//   MASTER_SHEET_ID   : マスター管理シートのID
//   GOOGLE_API_KEY    : Google Maps APIキー（ジオコーディング用）
//   PARENT_FOLDER_ID  : 顧客シートの保存先GoogleドライブフォルダID
//   FIELD_APP_URL     : 現場用マップアプリ（Index）の公開URL
// =====================================================================
var SCRIPT_PROPS = PropertiesService.getScriptProperties();
var MASTER_SHEET_ID = SCRIPT_PROPS.getProperty('MASTER_SHEET_ID');
var GOOGLE_API_KEY = SCRIPT_PROPS.getProperty('GOOGLE_API_KEY');
var PARENT_FOLDER_ID = SCRIPT_PROPS.getProperty('PARENT_FOLDER_ID');
var FIELD_APP_URL = SCRIPT_PROPS.getProperty('FIELD_APP_URL');

// =====================================================================
// 初回認証用テスト関数
// =====================================================================
function testAuthAndDrive() {
  var myEmail = Session.getActiveUser().getEmail();
  GmailApp.sendEmail(myEmail, "【テスト】エリアトラッカー権限確認", "メールおよびGoogleドライブの操作権限が正常に許可されました。");
  DriveApp.getRootFolder();
  console.log("テストメールの送信およびドライブ権限のチェックに成功しました。");
}

// =====================================================================
// エリアトラッカー SaaSバックエンド統合API
// =====================================================================

function doPost(e) {
  try {
    if (!MASTER_SHEET_ID || !GOOGLE_API_KEY) {
      throw new Error("スクリプト プロパティが未設定です。プロジェクトの設定でMASTER_SHEET_ID / GOOGLE_API_KEY / PARENT_FOLDER_ID / FIELD_APP_URLを登録してください。");
    }

    var params = JSON.parse(e.postData.contents);
    var action = params.action;

    if (action === "get_clients") { return createJsonResponse({ success: true, clients: [] }); }

    if (action === "register_client") {
      var name = params.name; var email = params.email; var username = params.username; var password = params.password;
      if (!name || !email || !username || !password) throw new Error("すべての必須項目を入力してください");

      var ss = SpreadsheetApp.openById(MASTER_SHEET_ID);
      var sheet = ss.getSheetByName("顧客マスタ");
      var data = sheet.getDataRange().getValues();
      
      for (var i = 1; i < data.length; i++) {
        if (String(data[i][4]) === username) throw new Error("指定されたユーザーIDは既に登録されています。");
      }

      var lastRow = sheet.getLastRow();
      var currentMax = 0;
      for (var j = 1; j < data.length; j++) {
        var match = String(data[j][0]).match(/^CUST_(\d+)$/);
        if (match) {
          var num = parseInt(match[1], 10);
          if (num > currentMax) currentMax = num;
        }
      }
      var newCode = "CUST_" + ("0000" + (currentMax + 1)).slice(-4);
      var newSs = createAndProtectSpreadsheet(newCode, name, email);
      sheet.getRange(lastRow + 1, 1, 1, 6).setValues([[newCode, newSs.getId(), name, email, username, password]]);
      
      try {
        sendWelcomeEmail(name, email, username, password, newSs.getUrl());
      } catch (mailError) {
        throw new Error("メール送信に失敗しました。詳細: " + mailError.message);
      }
      
      return createJsonResponse({ success: true, clientCode: newCode, clientName: name });
    }

    if (action === "upload_csv") {
      var clientCode = params.clientCode; var csvDataString = params.csvData;
      if (!clientCode || !csvDataString) throw new Error("パラメータが不足しています");
      var targetSheetId = getClientSheetId(clientCode);
      var result = optimizeAndProcessCsv(targetSheetId, JSON.parse(csvDataString));
      return createJsonResponse({ success: true, message: "保存成功", result: result });
    }

    if (action === "get_map_data") {
      var username = params.username; var password = params.password;
      if (!username || !password) throw new Error("ユーザーIDとパスワードを入力してください");
      var authData = authenticateClient(username, password);
      if (!authData) throw new Error("認証に失敗しました。");
      var mapData = fetchMapDataFromSheet(authData.sheetId);
      return createJsonResponse({ success: true, clientName: authData.name, clientCode: authData.code, spreadsheetId: authData.sheetId, data: mapData });
    }

    if (action === "update_status") {
      var sheetId = params.sheetId; var row = params.row;
      var status = params.status; var evaluation = params.evaluation;
      var updateSheet = SpreadsheetApp.openById(sheetId).getSheetByName("リスト");
      updateSheet.getRange(Number(row), 7).setValue(status || ""); // G列
      updateSheet.getRange(Number(row), 9).setValue(evaluation || ""); // 【変更】見込み度はI列
      return createJsonResponse({ success: true, message: "ステータス更新成功" });
    }

    return createJsonResponse({ success: false, error: "無効なアクションです" });

  } catch (error) {
    return createJsonResponse({ success: false, error: error.message });
  }
}

// =====================================================================
// コアロジック：自動分割・不備分離・【重複カウントアップ】処理
// =====================================================================
function optimizeAndProcessCsv(sheetId, csvData) {
  var ss = SpreadsheetApp.openById(sheetId);
  var normalSheet = ss.getSheetByName("リスト");
  var errorSheet = ss.getSheetByName("住所不備リスト");
  
  // 1. 既存データの取得（重複カウント用）
  var existingMap = {}; 
  if (normalSheet.getLastRow() > 1) {
    var normalData = normalSheet.getRange(2, 1, normalSheet.getLastRow() - 1, 8).getValues();
    for (var n = 0; n < normalData.length; n++) {
      var key = String(normalData[n][1]).trim() + "|" + String(normalData[n][2]).trim() + "|" + String(normalData[n][3]).trim();
      var count = parseInt(normalData[n][7], 10) || 1; // H列(世帯人数)
      existingMap[key] = { row: n + 2, count: count };
    }
  }
  
  var errorSet = new Set();
  if (errorSheet.getLastRow() > 1) {
    var errorData = errorSheet.getRange(2, 2, errorSheet.getLastRow() - 1, 3).getValues();
    for (var e = 0; e < errorData.length; e++) {
      errorSet.add(String(errorData[e][0]).trim() + "|" + String(errorData[e][1]).trim() + "|" + String(errorData[e][2]).trim());
    }
  }

  var totalCount = (normalSheet.getLastRow() - 1) + (errorSheet.getLastRow() - 1);
  var normalDataToWrite = [];
  var errorDataToWrite = [];
  var updateCounts = {};
  var skippedCount = 0;

  for (var i = 0; i < csvData.length; i++) {
    var rawAddress = csvData[i][0] ? String(csvData[i][0]).trim() : "";
    var rawName = csvData[i][1] ? String(csvData[i][1]).trim() : "";
    var extractedLastName = csvData[i][2] ? String(csvData[i][2]).trim() : ""; 
    if (!rawAddress) continue;

    var optimizedAddress = rawAddress;
    var optimizedName = rawName;

    if (!optimizedName) {
      var splitPattern = /([兼市区町村郡地地域].+?\d+[-－]?\d*[-－]?\d*)([ \u3000].+|[A-Za-z0-9階号棟室].*|[①-⑨].*|[^0-9\-－市区町村郡].+(?:ビル|マンション|アパート|ハイツ|コーポ|メゾン|レジデンス|ライオンズ|シャトー|プラザ|コート|ビルディング|エステート|ヴィラ|パレス|ステージ|テラス|スクエア|タワー|ルーム|H|h|F|f|号|室)).*$/;
      var match = rawAddress.match(splitPattern);
      if (match) { optimizedAddress = match[1].trim(); optimizedName = match[2].trim(); }
    }

    var keyOptimized = optimizedAddress + "|" + optimizedName + "|" + extractedLastName;
    var keyRaw = rawAddress + "|" + rawName + "|" + extractedLastName;

    if (errorSet.has(keyOptimized) || errorSet.has(keyRaw)) {
      skippedCount++;
      continue; 
    }

    // 重複を検知した場合、世帯人数をカウントアップしてAPI処理をスキップ
    if (existingMap[keyOptimized]) {
      existingMap[keyOptimized].count++;
      if (existingMap[keyOptimized].isNew) {
        normalDataToWrite[existingMap[keyOptimized].arrayIndex][7] = existingMap[keyOptimized].count;
      } else {
        updateCounts[existingMap[keyOptimized].row] = existingMap[keyOptimized].count;
      }
      skippedCount++;
      continue;
    }
    if (existingMap[keyRaw]) {
      existingMap[keyRaw].count++;
      if (existingMap[keyRaw].isNew) {
        normalDataToWrite[existingMap[keyRaw].arrayIndex][7] = existingMap[keyRaw].count;
      } else {
        updateCounts[existingMap[keyRaw].row] = existingMap[keyRaw].count;
      }
      skippedCount++;
      continue;
    }

    // 新規データ処理
    totalCount++; 
    var currentId = "ID_" + totalCount;
    var lat = ""; var lng = ""; var isError = false; var errorReason = "";

    try {
      var geoUrl = "https://maps.googleapis.com/maps/api/geocode/json?address=" + encodeURIComponent(optimizedAddress) + "&key=" + GOOGLE_API_KEY;
      var response = UrlFetchApp.fetch(geoUrl, { muteHttpExceptions: true });
      var json = JSON.parse(response.getContentText());
      
      if (json.status === "OK") {
        var result = json.results[0];
        var locationType = result.geometry.location_type;
        if (locationType === "ROOFTOP" || locationType === "RANGE_INTERPOLATED") {
          lat = result.geometry.location.lat; lng = result.geometry.location.lng;
        } else {
          isError = true; errorReason = "住所の精度不足 (Google判定: " + locationType + ")";
        }
      } else if (json.status === "OVER_QUERY_LIMIT") {
        isError = true; errorReason = "APIリクエスト数制限超過";
      } else {
        isError = true; errorReason = "存在しない住所または解析不能 (" + json.status + ")";
      }
    } catch(e) { isError = true; errorReason = "システム通信例外エラー"; }

    if (!isError) {
      // H列（[7]）に初期値の 1 をセット
      normalDataToWrite.push([currentId, optimizedAddress, optimizedName, extractedLastName, lat, lng, "未訪問", 1, ""]);
      existingMap[keyOptimized] = {
        row: normalSheet.getLastRow() + normalDataToWrite.length,
        count: 1,
        isNew: true,
        arrayIndex: normalDataToWrite.length - 1
      };
    } else {
      errorDataToWrite.push([currentId, rawAddress, rawName, extractedLastName, errorReason]);
      errorSet.add(keyOptimized);
    }
    Utilities.sleep(100);
  }

  // シートへの書き込み
  if (normalDataToWrite.length > 0) {
    normalSheet.getRange(normalSheet.getLastRow() + 1, 1, normalDataToWrite.length, normalDataToWrite[0].length).setValues(normalDataToWrite);
  }
  if (errorDataToWrite.length > 0) {
    errorSheet.getRange(errorSheet.getLastRow() + 1, 1, errorDataToWrite.length, errorDataToWrite[0].length).setValues(errorDataToWrite);
  }

  // 既存行へのカウントアップ（世帯人数の更新）
  var updatedRows = Object.keys(updateCounts);
  if (updatedRows.length > 0) {
    for (var r = 0; r < updatedRows.length; r++) {
      var rIdx = updatedRows[r];
      normalSheet.getRange(rIdx, 8).setValue(updateCounts[rIdx]); // H列に人数上書き
    }
  }

  return { addedNormal: normalDataToWrite.length, skipped: skippedCount };
}

// =====================================================================
// サブ関数群
// =====================================================================

function createAndProtectSpreadsheet(clientCode, name, email) {
  var newSs = SpreadsheetApp.create("エリアトラッカー【" + name + "様】");
  var sheet = newSs.getSheets()[0];
  sheet.setName("リスト");
  // 【変更】H列に「世帯人数」、I列に「見込み度」を配置
  var headerRange = sheet.getRange(1, 1, 1, 9);
  headerRange.setValues([["ID", "住所", "名称", "氏", "緯度", "経度", "ステータス", "世帯人数", "見込み度"]]);
  headerRange.setFontWeight("bold").setBackground("#f1f5f9");
  sheet.setFrozenRows(1);
  sheet.setColumnWidths(1, 4, 130);
  sheet.setColumnWidths(5, 2, 90);
  sheet.setColumnWidths(7, 3, 100);

  var errSheet = newSs.insertSheet("住所不備リスト");
  var errHeaderRange = errSheet.getRange(1, 1, 1, 5);
  errHeaderRange.setValues([["ID", "元データ住所", "元データ名称", "元データ氏名", "エラー原因"]]);
  errHeaderRange.setFontWeight("bold").setBackground("#fee2e2");
  errSheet.setFrozenRows(1);

  var file = DriveApp.getFileById(newSs.getId());
  file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
  try { file.addEditor(email); } catch (e) {}
  
  var me = Session.getEffectiveUser();
  var headerProtection = sheet.getRange("A1:I1").protect().setDescription("システムヘッダー");
  headerProtection.addEditor(me);
  headerProtection.removeEditors(headerProtection.getEditors().filter(function(u) { return u.getEmail() !== me.getEmail(); }));
  
  var colProtection = sheet.getRange("A2:F").protect().setDescription("システムデータ列");
  colProtection.addEditor(me);
  colProtection.removeEditors(colProtection.getEditors().filter(function(u) { return u.getEmail() !== me.getEmail(); }));

  if (PARENT_FOLDER_ID) {
    try { file.moveTo(DriveApp.getFolderById(PARENT_FOLDER_ID)); } catch (e) { }
  }
  return newSs;
}

function sendWelcomeEmail(name, email, username, password, sheetUrl) {
  var subject = "【エリアトラッカー】システム導入完了とログイン情報のご案内";
  var body = name + " 様\n\n"
           + "エリアトラッカーへのご登録ありがとうございます。\n"
           + "以下の通り、専用システムの自動構築が完了いたしました。\n\n"
           + "━━━━━━━━━━━━━━━━━━━━━━\n"
           + "■ 現場用マップアプリ（スタッフ様用）\n"
           + "URL: " + FIELD_APP_URL + "\n\n"
           + "【ログイン情報】\n"
           + "・ユーザーID: " + username + "\n"
           + "・パスワード: " + password + "\n"
           + "━━━━━━━━━━━━━━━━━━━━━━\n"
           + "■ 管理用データシート（管理者様用）\n"
           + "URL: " + sheetUrl + "\n\n"
           + "━━━━━━━━━━━━━━━━━━━━━━\n\n"
           + "【重要】\n"
           + "本システムにアップロードされるデータの管理責任はお客様に帰属します。\n"
           + "ログイン情報の取り扱いには十分ご注意ください。";
  GmailApp.sendEmail(email, subject, body);
}

function authenticateClient(username, password) {
  var data = SpreadsheetApp.openById(MASTER_SHEET_ID).getSheetByName("顧客マスタ").getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][4]) === username && String(data[i][5]) === password) return { code: data[i][0], sheetId: data[i][1], name: data[i][2] };
  }
  return null;
}

function fetchMapDataFromSheet(sheetId) {
  var sheet = SpreadsheetApp.openById(sheetId).getSheetByName("リスト");
  var values = sheet.getDataRange().getValues();
  var mapData = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (row[0]) {
      mapData.push({
        id: String(row[0]), 
        address: String(row[1] || ""), 
        displayName: String(row[2] || ""), 
        lastName: String(row[3] || ""),    
        lat: parseFloat(row[4] || 0), 
        lng: parseFloat(row[5] || 0), 
        status: String(row[6] || "未訪問"),
        householdCount: parseInt(row[7]) || 1, // H列(世帯人数)
        evaluation: String(row[8] || ""),      // I列(見込み度)
        publicRow: i + 1 
      });
    }
  }
  return mapData;
}

function getClientSheetId(clientCode) {
  var data = SpreadsheetApp.openById(MASTER_SHEET_ID).getSheetByName("顧客マスタ").getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === clientCode) return data[i][1];
  }
  throw new Error("登録されていない顧客コードです");
}

function createJsonResponse(data) {
  var output = ContentService.createTextOutput(JSON.stringify(data));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}