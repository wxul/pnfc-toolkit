# NTAG21x 命令参考

适用芯片：NTAG210 / 212 / 213 / 215 / 216（含 213F / 216F / 213 TT）
底层协议：ISO/IEC 14443-3 Type A · NFC Forum Type 2 Tag
数据速率：106 kbit/s

---

## 1. ISO14443-3 激活层

进入原生命令前，必须先完成防冲突与选卡。

| 命令 | 码 | 说明 |
|---|---|---|
| REQA | `26`（7 bit 短帧） | 请求应答 → ATQA `00 44` |
| WUPA | `52`（7 bit 短帧） | 唤醒，含 HALT 状态的卡 |
| ANTICOLLISION CL1 | `93 20` | 取 UID 第 1 级 |
| SELECT CL1 | `93 70` + 5 字节 + CRC | → SAK `04`（表示未完成，需 CL2） |
| ANTICOLLISION CL2 | `95 20` | 取 UID 第 2 级 |
| SELECT CL2 | `95 70` + 5 字节 + CRC | → SAK `00`（选中，非 -4 协议） |
| HLTA | `50 00` + CRC | 挂起 |

**NTAG 为 7 字节 UID，必须走两级 cascade：**

- CL1 返回 `88 UID0 UID1 UID2 BCC0`，其中 `88` 是 Cascade Tag
- CL2 返回 `UID3 UID4 UID5 UID6 BCC1`
- `BCC0 = 88 ⊕ UID0 ⊕ UID1 ⊕ UID2`
- `BCC1 = UID3 ⊕ UID4 ⊕ UID5 ⊕ UID6`

---

## 2. 原生命令总表

| 命令 | 码 | 参数 | 返回 |
|---|---|---|---|
| **GET_VERSION** | `60` | — | 8 字节 |
| **READ** | `30` | 起始页 | **16 字节**（4 页） |
| **FAST_READ** | `3A` | 起始页, 结束页 | (end−start+1)×4 字节 |
| **WRITE** | `A2` | 页, 4 字节数据 | ACK / NAK |
| **COMPATIBILITY_WRITE** | `A0` | 页 →（分两帧）16 字节 | ACK / NAK |
| **READ_CNT** | `39` | `02` | 3 字节，LSB first |
| **PWD_AUTH** | `1B` | PWD（4 字节） | PACK（2 字节）/ NAK |
| **READ_SIG** | `3C` | `00` | 32 字节 ECC 签名 |

> 所有命令末尾均需附 **CRC_A**（2 字节，小端）。返回的多字节数据同样带 CRC_A。
> 部分老型号（NTAG210/212）不支持 `READ_CNT`。

---

## 3. ACK / NAK 编码（4-bit 短帧）

| 值 | 含义 |
|---|---|
| `Ah` | ACK，操作成功 |
| `0h` | NAK，参数无效（页地址越界等） |
| `1h` | NAK，奇偶 / CRC 错误 |
| `4h` | NAK，EEPROM 写失败 |
| `5h` | NAK，**认证失败 / 写保护拒绝** |

> 验证密码保护是否真正生效，就看不认证写受保护页时能否收到 `5h`。

---

## 4. GET_VERSION 返回值解析

NTAG213 典型返回：`00 04 04 02 01 00 0F 03`

| 字节 | 值 | 含义 |
|---|---|---|
| 0 | `00` | 固定头 |
| 1 | `04` | Vendor ID = NXP |
| 2 | `04` | Product type = NTAG |
| 3 | `02` | Product subtype（50pF） |
| 4 | `01` | Major version |
| 5 | `00` | Minor version |
| 6 | `0F` | **存储容量代码** |
| 7 | `03` | 协议类型 = ISO14443-3 |

### 字节 6 型号对照

| 值 | 型号 | 用户区 | 总页数 |
|---|---|---|---|
| `0B` | NTAG210 | 48 B | 20 |
| `0E` | NTAG212 | 128 B | 41 |
| `0F` | **NTAG213** | 144 B | 45 |
| `11` | NTAG215 | 504 B | 135 |
| `13` | NTAG216 | 888 B | 231 |

**判定型号最可靠的方式**，优于 ATQA 或 CC 字节。字节 1 不是 `04` 基本可判定非正品 NXP 料。

---

## 5. 内存映射（以 NTAG213 为例，共 45 页）

| 页 | 内容 |
|---|---|
| 0–1 | UID（7 字节）+ BCC |
| 2 | 内部字节 + **static lock bytes**（byte 2–3） |
| 3 | **Capability Container**，默认 `E1 10 12 00` |
| 4–39 | 用户区（144 字节） |
| 40 (0x28) | **dynamic lock bytes**（byte 0–2），默认 `00 00 00 BD` |
| 41 (0x29) | **CFG0**：MIRROR / RFUI / MIRROR_PAGE / **AUTH0** |
| 42 (0x2A) | **CFG1**：ACCESS / RFUI，默认 `00 05 00 00` |
| 43 (0x2B) | **PWD**（32 bit） |
| 44 (0x2C) | **PACK**（16 bit）+ RFUI |

> NTAG215 用户区为 page 4–129，配置页在 131–134；
> NTAG216 用户区为 page 4–225，配置页在 227–230。

### CFG0 字节 3 = AUTH0

密码保护的**起始页地址**。

- 设为 ≥ 总页数（如默认 `FF`）→ 保护关闭
- 设为 `04` → 保护用户区起
- 设为 `00` → 全卡保护

### CFG1 字节 0 = ACCESS

| Bit | 名称 | 含义 |
|---|---|---|
| 7 | **PROT** | `0` = 仅写保护（读开放）；`1` = 读写均需认证 |
| 6 | **CFGLCK** | `1` = 配置页永久只读，**不可逆** |
| 5 | RFUI | 置 0 |
| 4 | NFC_CNT_EN | `1` = 启用 NFC 计数器 |
| 3 | NFC_CNT_PWD_PROT | `1` = READ_CNT 需认证 |
| 2–0 | **AUTHLIM** | 认证失败次数上限，`0` = 不限，`1–7` = 超限永久锁死 |

### 锁定位（Lock Bits）

- **Static lock bytes**（page 2 的 byte 2–3）→ 锁 page 3–15
- **Dynamic lock bytes**（page 40 的 byte 0–2）→ 锁 page 16–44
- 锁定粒度：NTAG213 每 **2 页**，NTAG215/216 每 **16 页**
- 写入为**按位 OR**，只能 0→1，**物理不可逆**
- 写 dynamic lock bytes 时，所有 RFUI 位必须置 0

---

## 6. 关键行为细节

**READ 一次返回 4 页，且会地址回绕。**
读到末页后自动 wrap 到起始页。例如 NTAG213 读 page 45 会返回 page 0 的内容——既是坑，也是判定总页数的手段。

**FAST_READ 有长度上限。**
受读卡器缓冲限制。PN532 的 `InDataExchange` 单帧承载有限，一次读几十页会失败，需分段。

**WRITE 只写 4 字节；COMPATIBILITY_WRITE 收 16 字节但仅前 4 字节生效**，后 12 字节被丢弃。后者仅为兼容老 MIFARE 读卡器存在，正常用 `A2`。

**PWD_AUTH 的认证状态仅在当前会话有效。**
卡片离场或收到 HLTA 后即失效，需重新认证。

**返回 PACK 不代表认证成功。**
部分兼容料无论密码对错都返回固定 PACK。可靠验证方式：
1. 不认证 → WRITE 受保护页 → 应收 NAK `5h`
2. 认证后 → WRITE 同一页 → 应收 ACK `Ah`

**READ_CNT 需先置 CFG1 的 NFC_CNT_EN 位**，否则返回 NAK。

**CC 页（page 3）与锁定位均为 OTP 语义**，按位 OR，写入不可逆。

**发可能返回 NAK 的命令，用 `InCommunicateThru (0x42)` 而非 `InDataExchange (0x40)`。**
后者会做协议层处理，4-bit NAK 常被吞掉或统一报为通用错误，无法区分"密码错"与"通信失败"。

---

## 7. 常用操作序列

### 读取配置区（NTAG213）

```
30 29 + CRC          → 返回 page 41–44（CFG0/CFG1/PWD/PACK）
```

### 启用密码写保护

```
A2 2B <PWD 4字节> + CRC      // 写 PWD
A2 2C <PACK 2字节> 00 00 + CRC  // 写 PACK
A2 2A 07 05 00 00 + CRC      // CFG1：AUTHLIM=7，PROT=0（仅写保护）
A2 29 04 00 00 04 + CRC      // CFG0：AUTH0=04，保护用户区起
```

> 顺序重要：先写 PWD/PACK，最后写 AUTH0。否则会把自己锁在外面。

### 认证后写入

```
1B <PWD 4字节> + CRC     // 期望返回 PACK（2 字节）
A2 04 <4字节数据> + CRC   // 期望 ACK (Ah)
```

### 打锁定位（永久只读，不可逆）

```
A2 02 <原byte0> <原byte1> FF FF + CRC   // static lock，锁 page 3–15
A2 28 FF FF FF BD + CRC                  // dynamic lock，锁 page 16–44
```

> page 2 前两字节是内部字节，必须**原样保留**（读出来是什么就写什么），写错会破坏 BCC1 导致卡片无法被选中。

### 验证真伪

```
60 + CRC                 // GET_VERSION，看字节 1 是否为 04
3C 00 + CRC              // READ_SIG，取 32 字节 ECC 签名
                         // 用 NXP 公钥验签（secp128r1）
```

---

## 8. 安全性边界

| 目标 | NTAG21x 能否做到 |
|---|---|
| 防止随手改写 | ✅ PWD_AUTH，配合 AUTHLIM |
| 永久防改写 | ✅ **锁定位**，硬件不可逆，最可靠 |
| 保护数据不被读取 | ⚠️ 可设 PROT=1，但口令明文传输，可嗅探 |
| 数据加密 | ❌ 无任何加密能力 |
| 防克隆 | ❌ 数据可完整复制到白卡 |
| 芯片验真 | ⚠️ READ_SIG 可验，但签名静态，可连同 UID 一起抄走 |

**需要真正的加密与防伪，应改用 NTAG 424 DNA**（Type 4 / ISO14443-4，AES-128 + SUN 动态 URL）。

---

## 9. 参考文档

- **NTAG213/215/216 Datasheet**（Rev 3.2）
  https://www.nxp.com/docs/en/data-sheet/NTAG213_215_216.pdf
- **AN13089 — NTAG 21x features and hints**
  https://www.puntoflotante.net/AN13089.pdf
- **NTAG213F/216F Datasheet**
  https://www.nxp.com/docs/en/data-sheet/NTAG213F_216F.pdf
- **NTAG 213 TagTamper Datasheet**
  https://www.nxp.com/docs/en/data-sheet/NT2H1311TT.pdf
- **libnfc**（`nfc-mfultralight.c` 为完整参考实现）
  https://github.com/nfc-tools/libnfc
- **Proxmark3**
  https://github.com/RfidResearchGroup/proxmark3