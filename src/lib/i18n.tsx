import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Locale = "zh" | "en";

type Params = Record<string, string | number>;
type Entry = string | ((params: Params) => string);

const STORAGE_KEY = "pnfc-toolkit:locale";

/**
 * Every translated string in the app lives in this one dictionary, keyed by a dotted namespace
 * (e.g. "titleBar.appName"). `en` is the source of truth for the key set — `zh`'s type is
 * derived from it (`Record<TranslationKey, Entry>`), so adding a key to one without the other
 * is a compile error instead of a silently missing translation.
 *
 * Most entries are plain strings; entries that need to interpolate a runtime value are
 * functions taking a `params` object instead.
 */
const en = {
  "titleBar.appName": "pnfc-toolkit",
  "titleBar.minimize": "Minimize",
  "titleBar.maximize": "Maximize",
  "titleBar.restore": "Restore",
  "titleBar.close": "Close",
  "titleBar.switchToZh": "Switch to Chinese",
  "titleBar.switchToEn": "Switch to English",

  "nav.device": "Device",
  "nav.read": "Read",
  "nav.write": "Write",
  "nav.other": "Other",
  "nav.settings": "Settings",
  "settings.comingSoonTitle": "Settings",
  "settings.comingSoonDescription": "App preferences are coming soon",

  "device.scanning": "Scanning for PN532 devices...",
  "device.notFound": "No PN532 device found",
  "device.rescan": "Rescan",
  "device.connect": "Connect",
  "device.connecting": "Connecting...",
  "device.connected": "Connected",
  "device.fieldPort": "Port",
  "device.fieldChip": "Chip",
  "device.fieldFirmwareVersion": "Firmware version",
  "device.fieldSupportByte": "Support byte",
  "device.fieldManufacturer": "Manufacturer",
  "device.fieldProductName": "Product name",
  "device.fieldVidPid": "VID:PID",
  "device.fieldSerialNumber": "Serial number",
  "device.disconnect": "Disconnect",
  "device.chipPn532": "PN532",
  "device.chipUnknown": (p) => `Unknown (0x${p.ic})`,
  "device.supportedTypesTitle": "Supported NFC tag types",
  "device.supportedTypeNtag": "NTAG21x / MIFARE Ultralight — read, write, password protection",
  "device.supportedTypeClassic": "MIFARE Classic 1K/4K/Mini — read, sector copy",
  "device.supportedTypesHint":
    "This is a software limitation, not a hardware one — the PN532 chip itself may be able to talk to other card types (ISO14443-4 smart cards, FeliCa, ISO15693, ...), this app just doesn't implement handling for them yet.",

  "common.clear": "Clear",
  "common.unknown": "Unknown",

  "readCard.connectFirst": 'Please connect a PN532 on the "Device" page first',
  "readCard.idleHint": 'Click "Start reading", then bring a card near the reader.',
  "readCard.startRead": "Start reading",
  "readCard.waitingForCard": "Bring a card near the reader...",
  "readCard.dumpCardGone":
    "The card was lifted before the read finished — retrying automatically once it's back on the reader.",
  "readCard.saveData": "Save data",
  "readCard.savedFeedback": "Saved",
  "readCard.unsupportedModel": (p) =>
    `Unsupported card model (SAK=0x${p.sak}) — this app only supports NTAG21x/MIFARE Ultralight and MIFARE Classic. Even if the PN532 hardware itself can talk to this card, this app's software hasn't implemented handling for it.`,
  "readCard.tagInfo": "Tag info",
  "readCard.fieldManufacturer": "Manufacturer",
  "readCard.fieldType": "Type",
  "readCard.fieldModel": "Model",
  "readCard.fieldDescription": "Description",
  "readCard.fieldId": "ID",
  "readCard.fieldCapacity": "Capacity",
  "readCard.bytesValue": (p) => `${p.n} bytes`,
  "readCard.copyToAnotherCard": "Copy to another card",
  "readCard.fieldDataFormat": "Data format",
  "readCard.fieldSize": "Size",
  "readCard.fieldWritable": "Writable",
  "readCard.fieldPasswordProtection": "Password protection",
  "readCard.passwordEnabled": (p) => `Enabled (AUTH0 = 0x${p.auth0})`,
  "readCard.passwordDisabled": (p) => `Disabled (AUTH0 = 0x${p.auth0})`,
  "readCard.readingFullInfo": "Reading full tag info...",
  "readCard.tabNdefData": "NDEF data",
  "readCard.tabAllData": "All data",
  "readCard.noNdefDetected": "No NDEF data detected (this card wasn't initialized in NFC Forum format)",
  "readCard.ndefFormattedButEmpty":
    "This tag has been initialized in NFC Forum format, but no NDEF data has been written yet (blank tag)",
  "readCard.recordLabel": (p) => `Record ${p.index}: `,
  "readCard.fullReadUnsupported":
    "Full memory reads aren't supported for this card type yet (only Ultralight/NTAG is supported so far)",
  "readCard.colPage": "Page",
  "readCard.colData": "Data",
  "readCard.colAscii": "ASCII",
  "readCard.colNote": "Note",
  "readCard.truncatedKnownModel":
    'A few pages failed to read and were skipped during the read (the rows showing "????????" in the table) — the rest were read normally; leaving the card in place will retry automatically.',
  "readCard.truncatedUnknownModel":
    "The model couldn't be identified, so there's no way to tell whether the end of the card was reached — the read stopped early here, there may be more unread pages.",
  "readCard.fieldChipVersion": "Chip version",
  "readCard.fieldSignature": "Originality signature",
  "readCard.fieldCounter": "One-way counter",
  "readCard.fieldTearingFlag": "Tearing flag",
  "readCard.tearingOk": (p) => `0x${p.hex} (no tearing detected)`,
  "readCard.tearingDetected": (p) => `0x${p.hex} (tearing detected)`,
  "readCard.exportTxt": "Export as text (.txt)",
  "readCard.exportFlipperNfc": "Export as Flipper (.nfc)",
  "readCard.exportRawBinary": "Export raw memory (.bin)",
  "readCard.exportFlipperUnavailable":
    "Flipper export needs the chip model identified, a complete page read, and this chip's originality signature — at least one of those isn't available",
  "readCard.saveTag": "Save tag",

  "other.toolSavedTagsTitle": "Saved tags",
  "other.toolSavedTagsDesc": "Browse full NTAG/Ultralight tag saves (every page, plus signature/counter data) and export them as text, Flipper, or raw binary.",

  "savedTags.empty": 'Nothing saved yet — use "Save tag" on the read page after reading an NTAG card.',

  "classicSector.cardRemoved": "The card was removed",
  "classicSector.scanningProgress": (p) => `Scanning sector ${p.current}/${p.total}...`,
  "classicSector.scanComplete": (p) =>
    `Scan complete: ${p.unlocked}/${p.total} sector(s) unlocked with the built-in dictionary`,
  "classicSector.colSector": "Sector",
  "classicSector.colStatus": "Status",
  "classicSector.colKey": "Key",
  "classicSector.unlocked": "Unlocked",
  "classicSector.locked": "Locked",
  "classicSector.collapse": "Collapse",
  "classicSector.viewData": "View data",
  "classicSector.trailerLabel": "Sector trailer (key/access bits)",
  "classicSector.unlockHint":
    "A locked sector doesn't mean anything's wrong with the card — its key just isn't in the built-in dictionary. It may be using a custom key; manually entering a key to authenticate isn't supported yet.",

  "classicCopy.title": "Copy to another card",
  "classicCopy.completedCount": (p) => ` (${p.count} card(s) done)`,
  "classicCopy.done": "Done",
  "classicCopy.writing": "Writing, keep the card held against the reader...",
  "classicCopy.stillSourceCard": "This is still the source card — swap in the card you want to write to",
  "classicCopy.placeTargetCard":
    "Place the target card and writing starts automatically; once done, you can swap in the next card to keep copying",
  "classicCopy.lastTargetCard": "Last target card: ",
  "classicCopy.uidCloneLabel": "UID cloned: ",
  "classicCopy.uidCloneSucceeded": "Succeeded",
  "classicCopy.uidCloneFailed":
    "Not cloned (the target card may not be a UID-writable magic/CUID card — a regular card's UID is fused at the factory, so failing to write it is expected)",
  "classicCopy.sectorsWritten": (p) => `${p.count} sector(s) written successfully`,
  "classicCopy.sectorsFailed": (p) => `, ${p.count} sector(s) failed`,
  "classicCopy.wrongCardType": "Skipped: the card just placed isn't a MIFARE Classic card — swap in one",

  "ntagCopy.title": "Copy to another card",
  "ntagCopy.completedCount": (p) => ` (${p.count} card(s) done)`,
  "ntagCopy.done": "Done",
  "ntagCopy.writing": "Writing, keep the card held against the reader...",
  "ntagCopy.stillSourceCard": "This is still the source card — swap in the card you want to write to",
  "ntagCopy.placeTargetCard":
    "Place the target card and writing starts automatically; once done, you can swap in the next card to keep copying",
  "ntagCopy.wrongCardType": "Skipped: the card just placed isn't an NTAG/Ultralight card — swap in one",
  "ntagCopy.lastTargetCard": "Last target card: ",
  "ntagCopy.copySucceeded": "Copied successfully",
  "ntagCopy.passwordPlaceholder": "Password for protected target cards, if any (optional, 8 hex digits)",

  "common.cancel": "Cancel",
  "common.processing": "Working...",

  "common.delete": "Delete",
  "common.export": "Export",
  "common.exported": "Exported",
  "common.exportFailed": "Export failed",

  "write.kindUrl": "URL",
  "write.kindText": "Plain text",
  "write.kindTel": "Phone number",
  "write.kindSms": "SMS",
  "write.kindMailto": "Email",
  "write.kindGeo": "Location",
  "write.kindVcard": "vCard",
  "write.kindWifi": "WiFi credentials",
  "write.latPlaceholder": "Latitude, e.g. 37.786971",
  "write.lngPlaceholder": "Longitude, e.g. -122.399677",
  "write.vcardFamilyName": "Last name (one of these is required)",
  "write.vcardGivenName": "First name (one of these is required)",
  "write.vcardNickname": "Nickname",
  "write.vcardOrg": "Company/Organization",
  "write.vcardTitle": "Job title",
  "write.vcardRole": "Role",
  "write.vcardPhone": "Phone",
  "write.vcardEmail": "Email",
  "write.vcardUrl": "Website",
  "write.vcardAdrStreet": "Street address",
  "write.vcardAdrCity": "City",
  "write.vcardAdrState": "State/Province",
  "write.vcardAdrPostalCode": "Postal code",
  "write.vcardAdrCountry": "Country",
  "write.vcardLabel": "Address text (optional, for older client compatibility)",
  "write.vcardNote": "Note",
  "write.vcardPhoto": "Photo URL",
  "write.vcardLogo": "Company logo URL",
  "write.vcardBday": "Birthday, e.g. 1990-01-01",
  "write.vcardAnniversary": "Anniversary, e.g. 2020-01-01",
  "write.vcardCategories": "Category tags",
  "write.vcardSwitchToRaw": "Edit as raw text (for multiple phone numbers, TYPE= parameters, etc.)",
  "write.vcardSwitchToForm": "Switch back to form",
  "write.vcardRawPlaceholder":
    "BEGIN:VCARD\nVERSION:3.0\nFN:Jane Doe\nTEL;TYPE=CELL:+1-555-0100\nTEL;TYPE=WORK,VOICE:+1-555-0101\nEND:VCARD",
  "write.wifiSsid": "SSID",
  "write.wifiPassword": "Password (WPA2-Personal/AES)",
  "write.urlPlaceholder": "https://example.com",
  "write.telPlaceholder": "+8613800138000",
  "write.textPlaceholder": "Text to write",
  "write.addRecord": "+ Add a record",
  "write.deleteRecord": "Delete",
  "write.writingInProgress": (p) => `Writing to ${p.uid}, keep the card held against the reader...`,
  "write.writeButton": "Write",
  "write.writeSuccess": "Write succeeded",

  "write.modeLabel": "Write mode (doesn't start writing by itself — use the button below)",
  "write.modeSingle": "Single card",
  "write.modeContinuous": "Continuous",
  "write.startContinuous": "Start continuous writing",
  "write.overwriteWarning":
    "Placing a card on the reader will immediately overwrite its NDEF data with the content above — make sure it's correct first.",
  "write.passwordModeText": "Text",
  "write.passwordModeHex": "Hex",
  "write.passwordTextPlaceholder": "Password text, if the card is protected (optional)",
  "write.passwordHexPlaceholder": "8 hex digits, if the card is protected (optional)",
  "write.passwordPreviewLabel": "Will be sent as",
  "write.passwordTruncateHint":
    "Text is UTF-8 encoded and fit into the 4 bytes NTAG's password uses — anything past the first 4 bytes is dropped, and it's zero-padded if shorter. This must match exactly what was used to set the password (e.g. in the password tool).",
  "write.passwordScopeHint":
    "This password only unlocks the card to write to it — it doesn't change or remove the card's password.",
  "write.stop": "Stop",
  "write.waitingForCard": "Waiting for a card...",
  "write.classicNotSupported": "Skipped: writing isn't supported for MIFARE Classic cards (only NTAG21x/MIFARE Ultralight)",
  "write.unsupportedModel": "Skipped: unsupported card model — this app only supports NTAG21x/MIFARE Ultralight and MIFARE Classic",
  "write.passwordRequired": "Skipped: this card is password-protected, but no valid password was entered",
  "write.checkFailed": "Failed to check password protection status",
  "write.successCount": (p) => `${p.count} succeeded`,
  "write.errorCount": (p) => `${p.count} failed`,
  "write.clearLog": "Clear log",

  "pwdTool.intro":
    "Quickly set or remove write-password protection on an NTAG/Ultralight card without reading it first — pick the password, then bring a card near the reader.",
  "pwdTool.modeText": "Text",
  "pwdTool.modeHex": "Hex",
  "pwdTool.textPlaceholder": "Password text",
  "pwdTool.hexPlaceholder": "8 hex digits",
  "pwdTool.previewLabel": "Will be written as",
  "pwdTool.truncateHint":
    "Text is UTF-8 encoded and fit into the 4 bytes NTAG's password uses — anything past the first 4 bytes is dropped, and it's zero-padded if shorter.",
  "pwdTool.setAndWait": "Set password, then wait for a card",
  "pwdTool.clearAndWait": "Remove password, then wait for a card",
  "pwdTool.waitingToSet": "Bring an NTAG card near the reader to set its password...",
  "pwdTool.waitingToClear": "Bring an NTAG card near the reader to remove its password...",
  "pwdTool.classicNotSupported": "Skipped: password protection isn't supported for MIFARE Classic cards (only NTAG21x/MIFARE Ultralight)",
  "pwdTool.unsupportedModel": "Skipped: unsupported card model — this app only supports NTAG21x/MIFARE Ultralight and MIFARE Classic",
  "pwdTool.setSuccess": "Password set successfully",
  "pwdTool.clearSuccess": "Password removed successfully",
  "pwdTool.processingUid": (p) => `Processing ${p.uid}, keep the card held against the reader...`,
  "pwdTool.stop": "Stop",
  "pwdTool.modeLabel": "Batch mode (doesn't start by itself — use the buttons below)",
  "pwdTool.modeSingle": "Single card",
  "pwdTool.modeContinuous": "Continuous",
  "pwdTool.successCount": (p) => `${p.count} succeeded`,
  "pwdTool.errorCount": (p) => `${p.count} failed`,
  "pwdTool.clearLog": "Clear log",

  "tagTool.intro":
    "Erase an NTAG/Ultralight card's NDEF content, or format a blank/reset one into NDEF-ready state. If the card has write-password protection, enter it below first.",
  "tagTool.passwordPlaceholder": "Write password, if any (optional, 8 hex digits)",
  "tagTool.eraseAndWait": "Erase content, then wait for a card",
  "tagTool.formatAndWait": "Format tag, then wait for a card",
  "tagTool.waitingToErase": "Bring an NTAG card near the reader to erase its content...",
  "tagTool.waitingToFormat": "Bring an NTAG card near the reader to format it...",
  "tagTool.warning": "This overwrites the tag's content and can't be undone.",
  "tagTool.classicNotSupported": "Skipped: erasing/formatting isn't supported for MIFARE Classic cards (only NTAG21x/MIFARE Ultralight)",
  "tagTool.unsupportedModel": "Skipped: unsupported card model — this app only supports NTAG21x/MIFARE Ultralight and MIFARE Classic",
  "tagTool.eraseSuccess": "Content erased successfully",
  "tagTool.formatSuccess": "Tag formatted successfully",
  "tagTool.startOver": "Start over",

  "other.intro": "Standalone single-purpose tools for the current card.",
  "other.back": "Back",
  "other.toolPasswordTitle": "Password tool",
  "other.toolPasswordDesc": "Set or remove NTAG/Ultralight write-password protection without reading the card first.",
  "other.toolSavedTitle": "Saved data",
  "other.toolSavedDesc": "Browse NTAG/Ultralight reads saved from the read page.",
  "other.toolTagTitle": "Tag management",
  "other.toolTagDesc": "Erase an NTAG/Ultralight tag's content, or format a blank one into NDEF-ready state.",

  "savedCards.empty": "Nothing saved yet — use \"Save data\" on the read page after reading an NTAG card.",
  "savedCards.write": "Write",

  "about.close": "Close",
  "about.description": "PN532 NFC debugging and operation tool",
  "about.version": "Version",
  "about.checking": "Checking for updates...",
  "about.upToDate": "You're on the latest version",
  "about.updateAvailable": (p) => `New version available: ${p.version}`,
  "about.installAndRestart": "Install and restart",
  "about.downloading": "Downloading update...",
  "about.updateError": "Failed to check for updates",
  "about.recheckUpdate": "Check again",
  "about.portableUpdateAvailable": (p) =>
    `New version available: ${p.version} — the portable build doesn't support in-app updates, please download it manually.`,
  "about.openReleasePage": "Open the releases page",
} satisfies Record<string, Entry>;

export type TranslationKey = keyof typeof en;

const zh: Record<TranslationKey, Entry> = {
  "titleBar.appName": "pnfc-toolkit",
  "titleBar.minimize": "最小化",
  "titleBar.maximize": "最大化",
  "titleBar.restore": "还原",
  "titleBar.close": "关闭",
  "titleBar.switchToZh": "切换到中文",
  "titleBar.switchToEn": "切换到英文",

  "nav.device": "设备",
  "nav.read": "读卡",
  "nav.write": "写入",
  "nav.other": "其它",
  "nav.settings": "设置",
  "settings.comingSoonTitle": "设置",
  "settings.comingSoonDescription": "应用偏好设置即将上线",

  "device.scanning": "正在扫描 PN532 设备...",
  "device.notFound": "未检测到 PN532 设备",
  "device.rescan": "重新检测",
  "device.connect": "连接",
  "device.connecting": "连接中...",
  "device.connected": "已连接",
  "device.fieldPort": "串口",
  "device.fieldChip": "芯片",
  "device.fieldFirmwareVersion": "固件版本",
  "device.fieldSupportByte": "Support 字节",
  "device.fieldManufacturer": "制造商",
  "device.fieldProductName": "产品名称",
  "device.fieldVidPid": "VID:PID",
  "device.fieldSerialNumber": "序列号",
  "device.disconnect": "断开连接",
  "device.chipPn532": "PN532",
  "device.chipUnknown": (p) => `未知 (0x${p.ic})`,
  "device.supportedTypesTitle": "支持的 NFC 标签类型",
  "device.supportedTypeNtag": "NTAG21x / MIFARE Ultralight —— 读取、写入、密码保护",
  "device.supportedTypeClassic": "MIFARE Classic 1K/4K/Mini —— 读取、按扇区复制",
  "device.supportedTypesHint":
    "这是软件层面的限制，不是硬件限制——PN532 芯片本身可能还能跟其它类型的卡通信（比如 ISO14443-4 智能卡、FeliCa、ISO15693 等），只是这个应用软件还没实现对它们的处理。",

  "common.clear": "清除",
  "common.unknown": "未知",

  "readCard.connectFirst": "请先在“设备”页连接 PN532",
  "readCard.idleHint": "点击“开始读取”，然后将卡片靠近读卡器。",
  "readCard.startRead": "开始读取",
  "readCard.waitingForCard": "请将卡片靠近读卡器...",
  "readCard.dumpCardGone": "读取还没完成卡就被拿开了，重新放上后会自动重试。",
  "readCard.saveData": "保存数据",
  "readCard.savedFeedback": "已保存",
  "readCard.unsupportedModel": (p) =>
    `不支持的卡片型号（SAK=0x${p.sak}）——本应用目前只支持 NTAG21x/MIFARE Ultralight 和 MIFARE Classic。即便 PN532 硬件本身能跟这张卡通信，软件这边还没实现对它的处理。`,
  "readCard.tagInfo": "标签信息",
  "readCard.fieldManufacturer": "厂商",
  "readCard.fieldType": "类型",
  "readCard.fieldModel": "型号",
  "readCard.fieldDescription": "描述",
  "readCard.fieldId": "ID",
  "readCard.fieldCapacity": "容量",
  "readCard.bytesValue": (p) => `${p.n} 字节`,
  "readCard.copyToAnotherCard": "复制写入到另一张卡",
  "readCard.fieldDataFormat": "数据格式",
  "readCard.fieldSize": "大小",
  "readCard.fieldWritable": "可写",
  "readCard.fieldPasswordProtection": "密码保护",
  "readCard.passwordEnabled": (p) => `已启用（AUTH0 = 0x${p.auth0}）`,
  "readCard.passwordDisabled": (p) => `未启用（AUTH0 = 0x${p.auth0}）`,
  "readCard.readingFullInfo": "正在读取完整信息...",
  "readCard.tabNdefData": "NDEF 数据",
  "readCard.tabAllData": "全部数据",
  "readCard.noNdefDetected": "未检测到 NDEF 数据（这张卡没有按 NFC Forum 格式初始化）",
  "readCard.ndefFormattedButEmpty":
    "这张标签已经按 NFC Forum 格式初始化，但当前没有写入任何 NDEF 数据（空白标签）",
  "readCard.recordLabel": (p) => `记录${p.index}: `,
  "readCard.fullReadUnsupported": "这张卡的类型暂不支持完整内存读取（目前只支持 Ultralight/NTAG 系列）",
  "readCard.colPage": "页",
  "readCard.colData": "数据",
  "readCard.colAscii": "ASCII",
  "readCard.colNote": "说明",
  "readCard.truncatedKnownModel":
    '读取过程中有个别页失败被跳过了（表格里数据是 "????????" 的那几行），其余页仍是正常读到的，卡还贴着的话会自动重试。',
  "readCard.truncatedUnknownModel":
    "型号没能识别出来，没法判断是不是已经读到卡片末尾，读取在这里提前停止了，可能还有更多页没读到。",
  "readCard.fieldChipVersion": "芯片版本",
  "readCard.fieldSignature": "原厂签名",
  "readCard.fieldCounter": "单向计数器",
  "readCard.fieldTearingFlag": "防拆标志",
  "readCard.tearingOk": (p) => `0x${p.hex}（未检测到断电攻击）`,
  "readCard.tearingDetected": (p) => `0x${p.hex}（检测到断电攻击）`,
  "readCard.exportTxt": "导出为文本 (.txt)",
  "readCard.exportFlipperNfc": "导出为 Flipper 格式 (.nfc)",
  "readCard.exportRawBinary": "导出原始内存 (.bin)",
  "readCard.exportFlipperUnavailable":
    "导出 Flipper 格式需要识别出芯片型号、页面完整读取成功、并且读到原厂签名——至少有一项现在不满足",
  "readCard.saveTag": "保存标签",

  "other.toolSavedTagsTitle": "已保存标签",
  "other.toolSavedTagsDesc": "查看完整保存的 NTAG/Ultralight 标签（含全部页面及签名/计数器数据），可导出为文本、Flipper 格式或原始二进制。",

  "savedTags.empty": "还没有保存过任何标签——在读卡页读完一张 NTAG 卡后点“保存标签”。",

  "classicSector.cardRemoved": "卡片已移开",
  "classicSector.scanningProgress": (p) => `正在扫描第 ${p.current}/${p.total} 扇区...`,
  "classicSector.scanComplete": (p) => `扫描完成：${p.unlocked}/${p.total} 个扇区已用内置字典解锁`,
  "classicSector.colSector": "扇区",
  "classicSector.colStatus": "状态",
  "classicSector.colKey": "密钥",
  "classicSector.unlocked": "已解锁",
  "classicSector.locked": "未解锁",
  "classicSector.collapse": "收起",
  "classicSector.viewData": "查看数据",
  "classicSector.trailerLabel": "扇区尾（密钥/存取控制位）",
  "classicSector.unlockHint":
    "未解锁的扇区不代表卡片有问题，只是密钥不在内置字典里——这些扇区可能用的是自定义密钥，目前还不支持手动输入密钥补认证。",

  "classicCopy.title": "复制到另一张卡",
  "classicCopy.completedCount": (p) => `（已完成 ${p.count} 张）`,
  "classicCopy.done": "完成",
  "classicCopy.writing": "正在写入，请保持卡片贴紧读卡器...",
  "classicCopy.stillSourceCard": "还是源卡本身，请换成要写入的目标卡",
  "classicCopy.placeTargetCard": "放上要写入的目标卡就会自动开始写入，写完可以直接换下一张卡继续复制",
  "classicCopy.lastTargetCard": "最近一次目标卡：",
  "classicCopy.uidCloneLabel": "UID 克隆：",
  "classicCopy.uidCloneSucceeded": "成功",
  "classicCopy.uidCloneFailed":
    "未成功（目标卡可能不是 UID 可写的 magic/CUID 卡，普通卡出厂就焊死了，写不进去是正常的）",
  "classicCopy.sectorsWritten": (p) => `成功写入 ${p.count} 个扇区`,
  "classicCopy.sectorsFailed": (p) => `，${p.count} 个扇区失败`,
  "classicCopy.wrongCardType": "已跳过：刚放上的卡不是 MIFARE Classic 卡，请换一张",

  "ntagCopy.title": "复制到另一张卡",
  "ntagCopy.completedCount": (p) => `（已完成 ${p.count} 张）`,
  "ntagCopy.done": "完成",
  "ntagCopy.writing": "正在写入，请保持卡片贴紧读卡器...",
  "ntagCopy.stillSourceCard": "还是源卡本身，请换成要写入的目标卡",
  "ntagCopy.placeTargetCard": "放上要写入的目标卡就会自动开始写入，写完可以直接换下一张卡继续复制",
  "ntagCopy.wrongCardType": "已跳过：刚放上的卡不是 NTAG/Ultralight 卡，请换一张",
  "ntagCopy.lastTargetCard": "最近一次目标卡：",
  "ntagCopy.copySucceeded": "复制成功",
  "ntagCopy.passwordPlaceholder": "如果目标卡有密码保护，填写密码（可选，8 位十六进制）",

  "common.cancel": "取消",
  "common.processing": "处理中...",

  "common.delete": "删除",
  "common.export": "导出",
  "common.exported": "已导出",
  "common.exportFailed": "导出失败",

  "write.kindUrl": "URL",
  "write.kindText": "纯文本",
  "write.kindTel": "电话号码",
  "write.kindSms": "短信",
  "write.kindMailto": "邮箱",
  "write.kindGeo": "地理位置",
  "write.kindVcard": "vCard 名片",
  "write.kindWifi": "WiFi 配置",
  "write.latPlaceholder": "纬度，如 37.786971",
  "write.lngPlaceholder": "经度，如 -122.399677",
  "write.vcardFamilyName": "姓（必填其一）",
  "write.vcardGivenName": "名（必填其一）",
  "write.vcardNickname": "昵称",
  "write.vcardOrg": "公司/组织",
  "write.vcardTitle": "职位",
  "write.vcardRole": "角色",
  "write.vcardPhone": "电话",
  "write.vcardEmail": "邮箱",
  "write.vcardUrl": "网站",
  "write.vcardAdrStreet": "街道地址",
  "write.vcardAdrCity": "城市",
  "write.vcardAdrState": "省/州",
  "write.vcardAdrPostalCode": "邮编",
  "write.vcardAdrCountry": "国家",
  "write.vcardLabel": "地址文本（可选，兼容旧客户端）",
  "write.vcardNote": "备注",
  "write.vcardPhoto": "头像 URL",
  "write.vcardLogo": "公司 Logo URL",
  "write.vcardBday": "生日，如 1990-01-01",
  "write.vcardAnniversary": "纪念日，如 2020-01-01",
  "write.vcardCategories": "分类标签",
  "write.vcardSwitchToRaw": "编辑原始文本（可填多个电话号码、TYPE= 参数等高级用法）",
  "write.vcardSwitchToForm": "切换回表单编辑",
  "write.vcardRawPlaceholder":
    "BEGIN:VCARD\nVERSION:3.0\nFN:张三\nTEL;TYPE=CELL:+86-138-0013-8000\nTEL;TYPE=WORK,VOICE:+86-10-12345678\nEND:VCARD",
  "write.wifiSsid": "SSID",
  "write.wifiPassword": "密码（WPA2-Personal/AES）",
  "write.urlPlaceholder": "https://example.com",
  "write.telPlaceholder": "+8613800138000",
  "write.textPlaceholder": "要写入的文本",
  "write.addRecord": "+ 添加一条记录",
  "write.deleteRecord": "删除",
  "write.writingInProgress": (p) => `正在写入 ${p.uid}，请保持卡片贴紧读卡器...`,
  "write.writeButton": "写入",
  "write.writeSuccess": "写入成功",

  "write.modeLabel": "写入方式（点这里不会直接开始写，实际开始要用下面的按钮）",
  "write.modeSingle": "单张",
  "write.modeContinuous": "连续",
  "write.startContinuous": "开始连续写入",
  "write.overwriteWarning": "把卡片放上读卡器后会立即用上面的内容覆盖写入 NDEF 数据，请先确认内容无误。",
  "write.passwordModeText": "文本",
  "write.passwordModeHex": "十六进制",
  "write.passwordTextPlaceholder": "如果卡片有密码保护，填写密码文本（可选）",
  "write.passwordHexPlaceholder": "如果卡片有密码保护，填写密码（可选，8 位十六进制）",
  "write.passwordPreviewLabel": "实际发送",
  "write.passwordTruncateHint":
    "文本会按 UTF-8 编码后截取前 4 个字节（NTAG 密码固定 4 字节），不足 4 字节则用 0 补齐。这里必须和设置密码时（比如在密码工具里）用的方式完全一致，才能得到同一个密码。",
  "write.passwordScopeHint": "此密码仅用于解锁并写入数据，不会修改或删除卡片密码。",
  "write.stop": "停止",
  "write.waitingForCard": "等待卡片中...",
  "write.classicNotSupported": "已跳过：写入功能暂不支持 MIFARE Classic 卡片（仅支持 NTAG21x/MIFARE Ultralight）",
  "write.unsupportedModel": "已跳过：不支持的卡片型号——本应用只支持 NTAG21x/MIFARE Ultralight 和 MIFARE Classic",
  "write.passwordRequired": "已跳过：这张卡启用了密码保护，但未输入有效密码",
  "write.checkFailed": "检查密码保护状态失败",
  "write.successCount": (p) => `成功 ${p.count} 张`,
  "write.errorCount": (p) => `失败 ${p.count} 张`,
  "write.clearLog": "清空记录",

  "pwdTool.intro": "无需先读卡，直接给一张 NTAG/Ultralight 卡快速设置或删除写密码保护——先选好密码，再把卡靠近读卡器。",
  "pwdTool.modeText": "文本",
  "pwdTool.modeHex": "十六进制",
  "pwdTool.textPlaceholder": "密码文本",
  "pwdTool.hexPlaceholder": "8 位十六进制",
  "pwdTool.previewLabel": "实际写入",
  "pwdTool.truncateHint": "文本会按 UTF-8 编码后截取前 4 个字节（NTAG 密码固定 4 字节），不足 4 字节则用 0 补齐。",
  "pwdTool.setAndWait": "设置密码并等待读卡",
  "pwdTool.clearAndWait": "删除密码并等待读卡",
  "pwdTool.waitingToSet": "请将 NTAG 卡靠近读卡器以设置密码...",
  "pwdTool.waitingToClear": "请将 NTAG 卡靠近读卡器以删除密码...",
  "pwdTool.classicNotSupported": "已跳过：密码保护功能暂不支持 MIFARE Classic 卡片（仅支持 NTAG21x/MIFARE Ultralight）",
  "pwdTool.unsupportedModel": "已跳过：不支持的卡片型号——本应用只支持 NTAG21x/MIFARE Ultralight 和 MIFARE Classic",
  "pwdTool.setSuccess": "密码设置成功",
  "pwdTool.clearSuccess": "密码已删除",
  "pwdTool.processingUid": (p) => `正在处理 ${p.uid}，请保持卡片贴紧读卡器...`,
  "pwdTool.stop": "停止",
  "pwdTool.modeLabel": "批量模式（点这里不会直接开始，实际开始要用下面的按钮）",
  "pwdTool.modeSingle": "单张",
  "pwdTool.modeContinuous": "连续",
  "pwdTool.successCount": (p) => `成功 ${p.count} 张`,
  "pwdTool.errorCount": (p) => `失败 ${p.count} 张`,
  "pwdTool.clearLog": "清空记录",

  "tagTool.intro": "清空一张 NTAG/Ultralight 卡片的 NDEF 内容，或把一张空白/需要重置的卡片格式化成 NDEF 可用状态。如果卡片有写密码保护，请先在下方填写密码。",
  "tagTool.passwordPlaceholder": "写密码（如果有，可选，8 位十六进制）",
  "tagTool.eraseAndWait": "清空内容并等待读卡",
  "tagTool.formatAndWait": "格式化标签并等待读卡",
  "tagTool.waitingToErase": "请将 NTAG 卡靠近读卡器以清空内容...",
  "tagTool.waitingToFormat": "请将 NTAG 卡靠近读卡器以格式化...",
  "tagTool.warning": "此操作会覆盖标签内容，且不可撤销。",
  "tagTool.classicNotSupported": "已跳过：删除/格式化功能暂不支持 MIFARE Classic 卡片（仅支持 NTAG21x/MIFARE Ultralight）",
  "tagTool.unsupportedModel": "已跳过：不支持的卡片型号——本应用只支持 NTAG21x/MIFARE Ultralight 和 MIFARE Classic",
  "tagTool.eraseSuccess": "内容已清空",
  "tagTool.formatSuccess": "标签格式化成功",
  "tagTool.startOver": "重新开始",

  "other.intro": "针对当前卡片的独立单一功能小工具。",
  "other.back": "返回",
  "other.toolPasswordTitle": "密码工具",
  "other.toolPasswordDesc": "无需先读卡，直接设置或删除 NTAG/Ultralight 的写密码保护。",
  "other.toolSavedTitle": "已保存数据",
  "other.toolSavedDesc": "查看读卡页保存下来的 NTAG/Ultralight 读取结果。",
  "other.toolTagTitle": "标签管理",
  "other.toolTagDesc": "清空 NTAG/Ultralight 标签的内容，或把空白标签格式化成 NDEF 可用状态。",

  "savedCards.empty": "还没有保存过任何数据——在读卡页读完一张 NTAG 卡后点“保存数据”。",
  "savedCards.write": "写入",

  "about.close": "关闭",
  "about.description": "PN532 NFC 调试与操作工具",
  "about.version": "版本",
  "about.checking": "正在检查更新...",
  "about.upToDate": "已是最新版本",
  "about.updateAvailable": (p) => `发现新版本：${p.version}`,
  "about.installAndRestart": "安装并重启",
  "about.downloading": "正在下载更新...",
  "about.updateError": "检查更新失败",
  "about.recheckUpdate": "重新检查",
  "about.portableUpdateAvailable": (p) => `发现新版本：${p.version} —— 免安装版不支持应用内自动更新，请手动下载新版本。`,
  "about.openReleasePage": "打开下载页",
};

const dictionaries: Record<Locale, Record<TranslationKey, Entry>> = { en, zh };

function resolve(entry: Entry, params?: Params): string {
  return typeof entry === "function" ? entry(params ?? {}) : entry;
}

function readStoredLocale(): Locale {
  if (typeof localStorage === "undefined") return "en";
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "en" || stored === "zh" ? stored : "en";
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: TranslationKey, params?: Params) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(readStoredLocale);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, locale);
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale: setLocaleState,
      t: (key, params) => resolve(dictionaries[locale][key], params),
    }),
    [locale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within an I18nProvider");
  return ctx;
}
