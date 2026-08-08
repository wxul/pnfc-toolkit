# MIFARE Classic 命令参考

适用芯片：MIFARE Classic 1K（MF1S50yyX）/ 4K（MF1S70yyX）/ Mini（MF1ICS20）
底层协议：ISO/IEC 14443-3 Type A（**私有协议，非 NFC Forum 标签类型**）
数据速率：106 kbit/s
安全算法：Crypto1（48-bit，**已被完全破解**）

---

## 1. ISO14443-3 激活层

| 命令 | 码 | 说明 |
|---|---|---|
| REQA | `26`（7 bit） | 请求应答 → ATQA |
| WUPA | `52`（7 bit） | 唤醒 |
| ANTICOLLISION CL1 | `93 20` | 取 UID |
| SELECT CL1 | `93 70` + 5 字节 + CRC | 选卡 → SAK |
| ANTICOLLISION CL2 | `95 20` | 取 UID（7 字节 UID 变体） |
| SELECT CL2 | `95 70` + 5 字节 + CRC | 选卡 |
| HLTA | `50 00` + CRC | 挂起 |

### ATQA / SAK 对照

| 卡型 | ATQA | SAK | UID |
|---|---|---|---|
| Classic 1K | `00 04` | `08` | 4 字节 |
| Classic 1K（7 字节 UID） | `00 44` | `08` | 7 字节 |
| Classic 4K | `00 02` | `18` | 4 字节 |
| Classic 4K（7 字节 UID） | `00 42` | `18` | 7 字节 |
| Classic Mini | `00 04` | `09` | 4 字节 |

> SAK bit5 = 0，表示**不支持 ISO14443-4**，无 RATS/ATS，无 APDU。

---

## 2. 存储结构

### 1K：16 扇区 × 4 块 × 16 字节 = 1024 字节

| 扇区 | 块 | 用途 |
|---|---|---|
| 0 | 0 | **制造商块**：UID + BCC + SAK + ATQA + 厂商数据（出厂只读） |
| 0 | 1–2 | 数据块 |
| 0 | 3 | **扇区尾块**：Key A(6B) + Access Bits(4B) + Key B(6B) |
| 1–15 | 每扇区 3 数据块 + 1 尾块 | 同上结构 |

### 4K：前 32 扇区同 1K 结构，后 8 扇区为 16 块/扇区

| 扇区 | 块结构 |
|---|---|
| 0–31 | 4 块（3 数据 + 1 尾块） |
| 32–39 | 16 块（15 数据 + 1 尾块） |

### 扇区尾块布局（16 字节）

```
┌──────────────┬──────────────┬──────────────┐
│  Key A (6B)  │ Access (4B)  │  Key B (6B)  │
│  byte 0–5    │  byte 6–9    │  byte 10–15  │
└──────────────┴──────────────┴──────────────┘
```

> **Key A 永远读不出**（读回全 0）。Key B 是否可读取决于访问位配置——若配成可读，则它占用的区域不能当密钥用。

---

## 3. 命令表

所有数据交互命令都必须**先通过 Crypto1 认证**，之后通信加密。

| 命令 | 码 | 参数 | 说明 |
|---|---|---|---|
| **AUTH Key A** | `60` | 块地址 | 用 Key A 认证扇区 |
| **AUTH Key B** | `61` | 块地址 | 用 Key B 认证扇区 |
| **READ** | `30` | 块地址 | 读 16 字节 |
| **WRITE** | `A0` | 块地址 → 16 字节 | 写整块（两帧） |
| **DECREMENT** | `C0` | 块地址 → 4 字节 | 值块减，结果入寄存器 |
| **INCREMENT** | `C1` | 块地址 → 4 字节 | 值块加，结果入寄存器 |
| **RESTORE** | `C2` | 块地址 → `00 00 00 00` | 值块读入寄存器 |
| **TRANSFER** | `B0` | 块地址 | 寄存器写回块 |

> Increment / Decrement / Restore 只把结果放进内部传输寄存器，**必须再发 TRANSFER 才真正写入 EEPROM**。

### 认证流程（Crypto1 三步握手）

```
Reader → 60/61 + 块地址 + CRC        // 请求认证
Card   → nonce Nt（明文，32 bit）
Reader → {Nr}{ar}（加密）             // reader nonce + answer
Card   → {at}（加密）                 // tag answer，认证完成
```

认证后所有命令与响应经 Crypto1 加密，密钥流随每字节推进。

---

## 4. Access Bits（访问控制位）

尾块 byte 6–9 控制该扇区的读写权限。**这是 Classic 上做防覆写的核心机制。**

### 编码结构

每块由三位 `C1 C2 C3` 控制。四个块（数据块 0/1/2 + 尾块 3）共 12 位，以正反两份存储于 byte 6–8，byte 9 为用户数据：

```
byte 6: C2₃ C2₂ C2₁ C2₀  C1₃ C1₂ C1₁ C1₀  （部分取反）
byte 7: C1₃ C1₂ C1₁ C1₀  C3₃ C3₂ C3₁ C3₀  （部分取反）
byte 8: C3₃ C3₂ C3₁ C3₀  C2₃ C2₂ C2₁ C2₀
byte 9: 用户自定义
```

> 存储含冗余取反校验，写错会导致该扇区**永久锁死**。务必用工具计算，不要手算。

### 数据块访问权限（C1 C2 C3）

| C1 C2 C3 | 读 | 写 | 增/减/传输 |
|---|---|---|---|
| `0 0 0` | A\|B | A\|B | A\|B |
| `0 1 0` | A\|B | 无 | 无 |
| `1 0 0` | A\|B | B | 无 |
| `1 1 0` | A\|B | B | A\|B |
| `0 0 1` | A\|B | 无 | A\|B（值块专用） |
| `0 1 1` | B | B | 无 |
| `1 0 1` | B | 无 | 无 |
| `1 1 1` | 无 | 无 | 无 |

> `A|B` = Key A 或 Key B 均可。表中 A/B 指对应密钥认证后才可执行。

**防覆写常用配置：**
- `0 1 0` → 两把钥匙都能读，**永不可写**
- `1 1 1` → 完全封锁（读写都禁）

### 尾块访问权限（C1 C2 C3）

| C1 C2 C3 | Key A 读/写 | Access 读/写 | Key B 读/写 |
|---|---|---|---|
| `0 0 0` | 否 / A | A / 否 | A / A |
| `0 0 1` | 否 / A | A / A | A / A |
| `1 0 0` | 否 / B | A\|B / 否 | 否 / B |
| `0 1 1` | 否 / B | A\|B / B | 否 / B |
| `1 0 1` | 否 / 否 | A\|B / 否 | 否 / 否 |
| `1 1 1` | 否 / 否 | A\|B / 否 | 否 / 否 |

> 若把尾块设成 access 位不可再写（如 `1 0 1`），则该扇区权限**永久固化**，无法恢复。

### 出厂默认

Access Bits 默认 `FF 07 80 69`，对应数据块 `0 0 0`（Key A/B 全权限），尾块允许改密钥与访问位。

---

## 5. 值块（Value Block）格式

用于 Increment/Decrement 的特殊 16 字节结构：

```
┌────────┬────────┬────────┬────┬────┬────┬────┐
│ value  │ ~value │ value  │adr │~adr│adr │~adr│
│ 4B LE  │ 4B LE  │ 4B LE  │ 1B │ 1B │ 1B │ 1B │
└────────┴────────┴────────┴────┴────┴────┴────┘
```

- value 存三份（正、反、正），供硬件校验
- adr 为 1 字节地址备份，存四份（正反正反）
- 格式不符则该块不被识别为值块，Increment 等操作失败

---

## 6. Crypto1 安全性（已完全破解）

| 攻击 | 前提 | 耗时 |
|---|---|---|
| 字典攻击 | 弱/默认密钥 | 秒级 |
| Darkside | 无需已知密钥 | 分钟级 |
| Nested | 已知任一扇区密钥 | 秒级 |
| Hardnested | 已知一密钥，应对加固卡 | 秒~分钟 |
| mfkey32 | 嗅探一次合法认证 | 即时 |
| 静态 nonce | 特定兼容料 | 即时 |

**常见默认密钥（字典必含）：**
```
FFFFFFFFFFFF   A0A1A2A3A4A5   D3F7D3F7D3F7
000000000000   B0B1B2B3B4B5   4D3A99C351DD
1A982C7E459A   AABBCCDDEEFF   714C5C886E97
```

> Crypto1 于 2008 年被逆向公开，NXP 早已标注不推荐新设计。工具已成熟到 Flipper Zero 一键操作。

---

## 7. Magic Card（魔术卡）

block 0 可改写的克隆专用卡。

| 代 | 俗称 | 特征 | 检测 |
|---|---|---|---|
| Gen1a | UID 卡 | 后门命令 `40`/`43`，免密改 block 0 | 易检测（后门指令响应） |
| **Gen2** | **CUID** | 认证后普通 WRITE 改 block 0 | 协议层难检测 |
| — | FUID | block 0 写一次后固化 | 固化后同正品 |
| — | UFUID | 可发封口命令锁死 | — |
| Gen4/UMC | 究极卡 | 可改 ATQA/SAK/UID 长度，模拟多种卡 | — |

### Gen1a 后门命令

```
40（7 bit）→ 卡回 ACK Ah
43         → 进入后门模式，之后可免认证读写 block 0
```

### 写 block 0 注意

```
block 0 = UID(4B) + BCC(1B) + SAK(1B) + ATQA(2B) + 厂商数据(8B)
BCC = UID0 ⊕ UID1 ⊕ UID2 ⊕ UID3
```

> BCC 算错会导致符合规范的读卡器在防冲突阶段拒绝该卡，很多设备之后再也选不中它。SAK 保持 `08`、ATQA 保持 `04 00`。

---

## 8. 防覆写方案对比（回到实际需求）

| 目标 | Classic 上的做法 | 可靠性 |
|---|---|---|
| 防止随手改写 | Access Bits 设 `0 1 0`（只读） | ⚠️ 密钥可破，破后能改回 |
| 永久防改写 | 尾块 access 设不可再写 | ⚠️ 同上，理论可逆 |
| 数据保密 | 认证后加密通信 | ❌ Crypto1 已破 |
| 防克隆 | 无 | ❌ 数据可完整复制 |

**结论：MIFARE Classic 无实际安全性可言。**

- 纯防覆写、内容固定 → 用 **NTAG213 打锁定位**（硬件不可逆）远比 Classic 干净
- 防伪防克隆 → **NTAG 424 DNA / DESFire EV3 / MIFARE Plus**
- CUID 本身是克隆工具卡，不应作安全载体使用

---

## 9. 命令序列示例

### 读某扇区（以扇区 1，块 4 为例）

```
60 04 + CRC              // Key A 认证扇区 1
（完成 Crypto1 握手）
30 04 + CRC              // 读块 4 → 16 字节
30 05 + CRC              // 读块 5
30 06 + CRC              // 读块 6
30 07 + CRC              // 读尾块（Key A 读回全 0）
```

### 写数据块

```
61 04 + CRC              // Key B 认证
A0 04 + CRC              // WRITE 请求，卡回 ACK
<16 字节数据> + CRC       // 数据帧，卡回 ACK
```

### 修改密钥 / 访问位（写尾块）

```
60 07 + CRC              // 认证扇区 1
A0 07 + CRC
<KeyA 6B><Access 4B><KeyB 6B> + CRC
```

> 写尾块前务必确认 Access Bits 计算正确，一次写错即永久锁死该扇区。

### 值块操作（块 8 减 10）

```
60 08 + CRC              // 认证
C0 08 + CRC              // DECREMENT 请求
0A 00 00 00 + CRC        // 减 10（LE）
B0 08 + CRC              // TRANSFER 写回
```

---

## 10. 参考文档

- **MIFARE Classic EV1 1K（MF1S50YYX_V1）Datasheet**
  https://www.nxp.com/docs/en/data-sheet/MF1S50YYX_V1.pdf
- **MF1S50yyX（Rev 3.0，DigiKey 镜像）**
  https://media.digikey.com/pdf/Data%20Sheets/NXP%20PDFs/MF1S50yyX.pdf
- **AN10833 — MIFARE type identification procedure**（ATQA/SAK 判型）
  搜 NXP 文档编号 AN10833
- **Proxmark3**（Crypto1 实现在 `common/crapto1/`，认证在 `armsrc/mifareutil.c`）
  https://github.com/RfidResearchGroup/proxmark3
- **libnfc**（`utils/nfc-mfclassic.c` 为完整读写参考）
  https://github.com/nfc-tools/libnfc
- **《Dismantling MIFARE Classic》**（Garcia et al., ESORICS 2008）— 攻击方法经典文献
- **《Reverse-Engineering a Cryptographic RFID Tag》**（Nohl et al., USENIX Security 2008）

> 官方数据手册**不含 Crypto1 算法与认证加密细节**（NXP 从未公开）。该部分只能参考上述逆向文献与 Proxmark3 源码。