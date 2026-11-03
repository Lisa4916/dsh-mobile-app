# 本地敏感数据的存放边界：token、备份与「界面文案不能撒谎」

手机 App 里最常出现的自我欺骗是：**界面文案写着「不保存任何密钥」，而 `shared_prefs` 里明文躺着口令**。写文案的人未必在撒谎，多半是写文案的时候确实没存，后来为了可用性加了持久化，文案没人回头改。

## 一、先把「存了没有」查清楚

别信代码注释，直接看落地文件：

```
adb shell run-as <pkg> cat /data/data/<pkg>/shared_prefs/<name>.xml
adb shell run-as <pkg> ls -R /data/data/<pkg>/
```

本项目实测就在这里翻车：文案写「App 不保存任何密钥」，而 `dsh_endpoints.xml` 里两条连接地址都带着明文 `?token=`。

## 二、先判断该不该存，再决定怎么说

以「带一次性凭据的 URL」为例，两边都有代价：

- **存**：用户不必每次电脑重启后重新扫码。代价是本地明文凭据。这个凭据本身有寿命上限——本项目里 cookie 的真实寿命等于服务端进程寿命，`token` 只是入口凭据，泄漏它需要先拿到设备文件。
- **不存**：文案可以干净，但每次电脑重启都要重新扫码。这是用**可用性**换一句漂亮话。

判据不是「安全 vs 不安全」，而是：**泄漏它的前提是什么、泄漏后的影响面多大、不存的实际成本多高。** 三条都算清楚再选。

选「存」就**改文案**，别改代码去凑文案。空话是最贵的债：它让后来的人以为这里不需要防护。

## 三、存了之后的四层防线

按性价比排：

1. **`android:allowBackup="false"`** —— 一行改动，直接把数据从云备份和设备间迁移里排除。存 token 的 App 这是最低要求。
2. **`android:dataExtractionRules`**（`targetSdk 31+`）—— 如果还想保留备份能力，就用规则文件把敏感文件排除，而不是一刀切关掉：
   ```xml
   <data-extraction-rules>
     <cloud-backup>
       <exclude domain="sharedpref" path="<敏感的那个>.xml"/>
     </cloud-backup>
     <device-transfer>
       <exclude domain="sharedpref" path="<敏感的那个>.xml"/>
     </device-transfer>
   </data-extraction-rules>
   ```
   注意 `cloud-backup` 与 `device-transfer` 是**两套规则**，只写一套的话另一条路照样会流出去。
3. **`EncryptedSharedPreferences` / Keystore** —— 真正的加密存储。代价是密钥本身也归 Keystore 管，设备迁移时数据无法带走；且多一层依赖。
4. **缩短凭据寿命** —— 比加密更有效。如果凭据 30 天有效且随时可换 PIN 作废，那它被盗的窗口本来就不大。

本项目的取舍：`allowBackup=false` + 明文存 + 文案说实话。理由是设备未 root 时其他 App 读不到 `/data/data/<pkg>/`，而 `EncryptedSharedPreferences` 会给「换电脑/换机」这条路径增加额外失败模式，收益不划算。

## 四、文案怎么写才算诚实

不要写「绝对安全」这种无法验证的话，写**边界**：

```
地址（含访问 PIN）只保存在本机，不会上传；
换电脑或不再使用这台，长按列表项删除
```

三个要素：
1. 存了什么（地址 + PIN）
2. 存在哪 / 会不会外传（本机、不上传）
3. **怎么删**（长按删除）

第三点最常被忘。告诉用户「数据在你手机上」而不告诉他怎么清掉，等于让他自己猜。

## 五、自检清单

- [ ] 用 `run-as` 真看过 `shared_prefs` / `databases` / `files`，不是靠读代码猜
- [ ] 界面上的每一句安全承诺，都能在落地文件里对得上
- [ ] 存了敏感数据 → `allowBackup="false"`，或用 `dataExtractionRules` 两套规则都排除
- [ ] 明文流量限制写在 `networkSecurityConfig`（WebView 不认 `usesCleartextTraffic`）
- [ ] 文案里写清了「怎么删」

## 六、一个相邻的坑：多用户 / 应用分身

检查已装状态时别忘了分身用户。`pm list packages` 默认只列当前用户，桌面上可能出现三个同名图标：

```
adb shell pm list users
adb shell pm list packages --user 900 | grep <pkg>
adb shell pm uninstall --user 900 <pkg>
```

这个坑和敏感数据直接相关：分身里的那份数据是**同一份代码的另一个实例**，两边的 `shared_prefs` 互相独立，用户以为删了就没了，其实另一个用户下还留着。
