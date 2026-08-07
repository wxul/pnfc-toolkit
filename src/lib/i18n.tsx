import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Locale = "zh" | "en";

type Params = Record<string, string | number>;
type Entry = string | ((params: Params) => string);

const STORAGE_KEY = "pn532-toolkit:locale";

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
  "titleBar.appName": "pn532-toolkit",
  "titleBar.minimize": "Minimize",
  "titleBar.maximize": "Maximize",
  "titleBar.restore": "Restore",
  "titleBar.close": "Close",
  "titleBar.switchToZh": "Switch to Chinese",
  "titleBar.switchToEn": "Switch to English",

  "nav.device": "Device",
  "nav.read": "Read",
  "nav.write": "Write",
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

  "common.clear": "Clear",
  "common.unknown": "Unknown",

  "readCard.connectFirst": 'Please connect a PN532 on the "Device" page first',
  "readCard.waitingForCard": "Bring a card near the reader...",
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
  "readCard.fieldCanBeReadOnly": "Can be made read-only",
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

  "common.cancel": "Cancel",
  "common.processing": "Working...",

  "pwdProtect.notRecognized": "Couldn't identify this tag's specific model; password protection isn't supported yet",
  "pwdProtect.changePassword": "Change password",
  "pwdProtect.removeProtection": "Remove protection",
  "pwdProtect.setProtection": "Set up password protection",
  "pwdProtect.removeTitle": "Remove password protection",
  "pwdProtect.currentPasswordPlaceholder": "Current password (8 hex digits)",
  "pwdProtect.confirmRemove": "Confirm removal",
  "pwdProtect.protectionExplanation":
    "The password only protects writes — this card can still be read normally. Once set, any future change to this card (including changing the password again, or removing protection) will require this password. There's no recovery method for the tag itself — if you forget the password, this card will be permanently unwritable, so be sure to write the password down now.",
  "pwdProtect.newPasswordPlaceholder": "New password (8 hex digits)",
  "pwdProtect.generateRandom": "Generate random password",
  "pwdProtect.confirmNewPasswordPlaceholder": "Re-enter the new password to confirm you got it right",
  "pwdProtect.acknowledgeCheckbox": "I've written this password down",
  "pwdProtect.confirmChange": "Confirm change",
  "pwdProtect.confirmSet": "Confirm setup",

  "common.delete": "Delete",

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
  "write.wifiSsid": "SSID",
  "write.wifiPassword": "Password (WPA2-Personal/AES)",
  "write.urlPlaceholder": "https://example.com",
  "write.telPlaceholder": "+8613800138000",
  "write.textPlaceholder": "Text to write",
  "write.addRecord": "+ Add a record",
  "write.deleteRecord": "Delete",
  "write.writingInProgress": (p) => `Writing to ${p.uid}, keep the card held against the reader...`,
  "write.confirmOverwrite": (p) =>
    `Writing will overwrite this card's existing NDEF data with ${p.count} record(s) — continue?`,
  "write.passwordPlaceholder": "This card has write-password protection enabled — enter the password (8 hex digits)",
  "write.confirmWrite": "Confirm write",
  "write.writeButton": "Write",
  "write.writeCountSuffix": (p) => ` (${p.count} records)`,
  "write.writeSuccess": "Write succeeded",
  "write.unsupportedCardType": (p) => `The current card is ${p.type}; writing is currently only supported for the Ultralight/NTAG family`,

  "about.close": "Close",
  "about.description": "PN532 NFC debugging and operation tool",
  "about.version": "Version",
} satisfies Record<string, Entry>;

export type TranslationKey = keyof typeof en;

const zh: Record<TranslationKey, Entry> = {
  "titleBar.appName": "pn532-toolkit",
  "titleBar.minimize": "最小化",
  "titleBar.maximize": "最大化",
  "titleBar.restore": "还原",
  "titleBar.close": "关闭",
  "titleBar.switchToZh": "切换到中文",
  "titleBar.switchToEn": "切换到英文",

  "nav.device": "设备",
  "nav.read": "读卡",
  "nav.write": "写入",
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

  "common.clear": "清除",
  "common.unknown": "未知",

  "readCard.connectFirst": "请先在“设备”页连接 PN532",
  "readCard.waitingForCard": "请将卡片靠近读卡器...",
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
  "readCard.fieldCanBeReadOnly": "可为只读",
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

  "common.cancel": "取消",
  "common.processing": "处理中...",

  "pwdProtect.notRecognized": "无法识别这张标签的具体型号，暂不支持设置密码保护",
  "pwdProtect.changePassword": "修改密码",
  "pwdProtect.removeProtection": "取消保护",
  "pwdProtect.setProtection": "设置密码保护",
  "pwdProtect.removeTitle": "取消密码保护",
  "pwdProtect.currentPasswordPlaceholder": "当前密码（8 位十六进制）",
  "pwdProtect.confirmRemove": "确认取消保护",
  "pwdProtect.protectionExplanation":
    "密码只保护写入，这张卡仍然可以正常读取；设置后，之后修改这张卡（包括再次改密码、取消保护）都需要提供这个密码。标签本身不提供找回方式，忘记密码这张卡将永久无法再写入，请务必现在就把密码记下来。",
  "pwdProtect.newPasswordPlaceholder": "新密码（8 位十六进制）",
  "pwdProtect.generateRandom": "生成随机密码",
  "pwdProtect.confirmNewPasswordPlaceholder": "再输入一次新密码，确认没有记错",
  "pwdProtect.acknowledgeCheckbox": "我已经把这个密码记下来了",
  "pwdProtect.confirmChange": "确认修改",
  "pwdProtect.confirmSet": "确认设置",

  "common.delete": "删除",

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
  "write.wifiSsid": "SSID",
  "write.wifiPassword": "密码（WPA2-Personal/AES）",
  "write.urlPlaceholder": "https://example.com",
  "write.telPlaceholder": "+8613800138000",
  "write.textPlaceholder": "要写入的文本",
  "write.addRecord": "+ 添加一条记录",
  "write.deleteRecord": "删除",
  "write.writingInProgress": (p) => `正在写入 ${p.uid}，请保持卡片贴紧读卡器...`,
  "write.confirmOverwrite": (p) => `写入会覆盖这张卡上原有的 NDEF 数据，将写入 ${p.count} 条记录，确认继续吗？`,
  "write.passwordPlaceholder": "这张卡启用了写密码保护，请输入密码（8 位十六进制）",
  "write.confirmWrite": "确认写入",
  "write.writeButton": "写入",
  "write.writeCountSuffix": (p) => `（共 ${p.count} 条）`,
  "write.writeSuccess": "写入成功",
  "write.unsupportedCardType": (p) => `当前卡片是 ${p.type}，写入功能目前只支持 Ultralight/NTAG 系列`,

  "about.close": "关闭",
  "about.description": "PN532 NFC 调试与操作工具",
  "about.version": "版本",
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
