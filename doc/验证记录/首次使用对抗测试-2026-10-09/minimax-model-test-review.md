
# E2E 测试草稿审查报告

## 审查范围说明
- 审查对象：`test/e2e/model-setup.test.ts`、`test/e2e/helpers.mjs`
- 审查标准：正常UI填服务商/model/baseURL/key→保存（不发请求）→发送→本地协议服务器收到精确Authorization及model→真实SDK正文显示→真正关闭并重开同state→第二次发送。401必须实际触发并断言错误与已接收语义；保存I/O失败不得ok:true；失败清理先退出测试进程，不删除活进程数据。

---

## 一、阻塞性问题（测试误放行 / 名实不符）

### 1.1 第一个测试：声称"重开仍可用"但从未重开应用

**代码位置**：`test/e2e/model-setup.test.ts` 第 86-91 行

```javascript
// 明确关闭、重开同一目录仍可用
await page.keyboard.press("Escape").catch(() => undefined);
await close();       // ← 测试在此处结束
} finally {
  await server.close();
  rmSync(stateDir, { recursive: true, force: true });  // ← 立即清理数据目录
  writeFileSync(join(EVID, "model-setup-first-run.json"), ...);
}
```

**可观察后果**：
- 测试名称明确声称"重开仍可用"
- 实际行为：`close()` 后没有任何重新 `launchApp(stateDir)` 的代码
- 数据目录在 `close()` 后立即被 `rmSync` 删除
- **没有验证保存的状态在重新启动后是否真正可用**

**判为阻塞**：测试名称与实现严重不符。若此测试通过，将虚假声称"重开仍可用"已验证，但实际完全未测试。

---

### 1.2 第二个测试：声称"401 可见错误"但未断言任何错误 UI

**代码位置**：`test/e2e/model-setup.test.ts` 第 113-126 行

```javascript
// 尝试实际发送
await composer.fill("触发 401 测试行为");
await composer.press("Enter").catch(() => undefined);
await page.waitForTimeout(1500);  // ← 仅等待 1.5 秒
// 检查快照里不发 key；界面不转回错 key；凭据文件已加密
const snapshotText = await page.evaluate(() => document.body.innerText);
assert.ok(!snapshotText.includes(wrongKey), "界面不得转回错 key");
```

**可观察后果**：
- 测试名称声称"401 可见错误：不正确 key 时界面提示"
- 实际行为：只检查了快照中不包含 `wrongKey`
- **没有等待/断言任何错误消息出现**
- **没有检查界面是否显示"模型不可用"状态**
- 项目标准明确要求"401必须实际触发并断言错误与已接收语义"

**判为阻塞**：测试通过只证明 key 未回显，但完全未验证 401 错误是否被用户可见地提示。

---

### 1.3 第一个测试：未断言"已保存"/"已配置"状态

**代码位置**：`test/e2e/model-setup.test.ts` 第 68-71 行

```javascript
await page.getByRole("button", { name: "保存" }).click();
await page.getByText("已保存").waitFor();   // ← 等待了 UI
await page.getByText("已配置").waitFor();   // ← 等待了 UI
evidence.steps?.push?.("setup-saved");
```

**可观察后果**：
- 代码等待了"已保存"和"已配置"文本出现
- 但**没有 `assert` 断言这些元素确实存在**
- `waitFor()` 若超时会导致测试失败（这是正确的），但若 UI 文本变化而超时时间足够长，可能误放行

**判为非阻塞**：超时机制提供了部分保护，但建议显式断言。

---

## 二、非阻塞性问题（用例未被命令执行 / 步骤缺失）

### 2.1 凭据加密验证不完整

**代码位置**：第一个测试 第 83-84 行

```javascript
const secretRaw = await import("node:fs/promises").then((m) => m.readFile(secretPath, "utf8"));
assert.ok(!secretRaw.includes(process.env.DCODE_TEST_KEY), "凭据文件不得含明文 key");
```

**可观察后果**：
- 仅验证"不包含明文 key"
- **未验证是否真正使用了加密**（如检查文件是否为非明文 JSON、是否有加密结构）
- 若实现仅做 base64 编码（而非加密），测试会错误通过

**判为非阻塞**：符合"凭据不回显"字面要求，但与项目标准中"已加密落盘"的语义存在差距。

---

### 2.2 服务器接收 model 验证不足

**代码位置**：第一个测试 第 81-82 行

```javascript
const postWithModel = authHits.find((r) => r.method === "POST" && 
  (r.url.includes("/chat") || r.chunks[0]?.includes("test-model") || r.chunks[0]?.includes("test-model")));
```

**可观察后果**：
- 检查条件为 `url.includes("/chat") || chunks[0]?.includes("test-model")`
- chunks 为请求体，但 SSE 流式响应测试的是服务器**返回**内容
- **未验证服务器接收到的请求体中 `model` 字段值是否为 `test-model`**

**判为非阻塞**：部分覆盖，但未完整验证请求 payload 中的 model 字段。

---

### 2.3 未验证 401 后界面状态切换

**代码位置**：第二个测试 第 113-126 行

**可观察后果**：
- 项目标准明确要求 401 触发后应看到"模型不可用"状态
- 当前可访问名称是按钮"设置 模型不可用""模型 不可用"
- **测试未检查这些元素在 401 后是否出现**

**判为非阻塞**：但与标准要求不符。

---

## 三、资源泄漏 / 清理问题

### 3.1 第二个测试：close() 未 await 且 cleanup 失败静默

**代码位置**：`test/e2e/model-setup.test.ts` 第 128-133 行

```javascript
} finally {
  await server.close();
  await close().catch(() => undefined);  // ← .catch 吞掉了 close 失败
  cleanup(stateDir);                     // ← cleanup 函数内部错误被静默
}
```

**helpers.mjs 中 cleanup 函数**：
```javascript
export function cleanup(dir) {
  if (liveProcesses.has(dir)) {
    throw new Error(`refusing to clean up data dir of a live process: ${dir}`);
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 清理失败不影响结果  ← 错误被静默
  }
}
```

**可观察后果**：
- `close().catch(() => undefined)` 会静默吞掉 Electron 进程未退出的错误
- 项目标准明确要求"失败清理先退出测试进程"
- `cleanup` 中 `catch` 块静默错误，不符合"失败清理"要求

**判为非阻塞（但违反标准）**：`close()` 本身的超时机制（15 秒）在 helpers.mjs 中已实现，但 `.catch()` 会隐藏超时错误。

---

### 3.2 第一个测试：重开缺失导致"重开后仍可用"无法验证

**代码位置**：第一个测试 finally 块

**可观察后果**：
- 若添加重开逻辑，`close()` 后立即 `rmSync` 会导致重开失败
- 当前缺失重开逻辑，该问题暂未暴露，但修复后需注意清理顺序

**判为非阻塞**：但修复阻塞问题 1.1 时需注意。

---

## 四、测试名称名实不符汇总

| 测试名称 | 声称内容 | 实际行为 | 判为 |
|---------|---------|---------|-----|
| "真实 UI：首次添加服务商 → 真实发送 → 重开仍可用；401 可见错误，凭据不回显" | 重开仍可用 | 无重开代码 | **阻塞** |
| "真实 UI：首次添加服务商 → 真实发送 → 重开仍可用；401 可见错误，凭据不回显" | 401 可见错误 | 未断言任何错误 UI | **阻塞** |
| "保存失败与 401 可见错误：不正确 key 时界面提示，快照证书不含 key" | 保存失败 | 保存成功（凭据写入文件） | 非阻塞（字面歧义） |

---

## 五、总结

### 阻塞性问题（必须修复）
1. **测试 1 缺少重开验证**：名称声称"重开仍可用"但无重开代码，导致虚假通过
2. **测试 2 缺少 401 错误 UI 断言**：名称声称"401 可见错误"但未检查任何错误提示元素

### 非阻塞问题（建议补充）
3. 凭据加密验证仅检查"不含明文"，未验证加密结构
4. 401 后界面状态切换未验证（应出现"模型不可用"）
5. cleanup 函数的静默 catch 违反"失败清理"标准
6. 服务器请求体中 model 字段验证不完整

### 建议行动
- **立即**：为测试 1 添加重开逻辑 `launchApp(stateDir)` 并验证状态可用
- **立即**：为测试 2 添加 `await page.getByRole("button", { name: "模型不可用" }).waitFor()` 断言
- **后续**：补充凭据加密结构验证和服务器 model 字段验证