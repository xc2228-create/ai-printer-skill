# @local/printer · DSH 插件（host half）

把打印 CLI 包成三个 DSH tool，让 agent 在会话里直接查打印机、打印、排障。

- `printer_list` —— 列打印机（名字 / 状态 / 是否默认 / 是否白名单 / 虚拟还是真机）
- `printer_print` —— 打印一个 txt/md/png/jpg 文件（`printer` 必填）
- `printer_status` —— CLI 版本、config 路径、白名单、输出目录、支持/禁止的格式

三个 tool 内部都是 `child_process.spawn(process.execPath, [print-cli.mjs, ... --json])`，
拿 CLI 的 JSON 信封再转成 tool 的返回值。权限、白名单、份数上限、扩展名拒绝全在 CLI 里，
插件不复制一套规则，避免两处判断不一致。

## 装法

推荐用安装器（会自动备份 `cordis.patch.yml` 再追加注册段）：

~~~powershell
# 沙盒实例（9081）
powershell -NoProfile -ExecutionPolicy Bypass -File ..\..\install.ps1 -WithDsh -DshHome $env:USERPROFILE\.dsh\home

# 生产实例
powershell -NoProfile -ExecutionPolicy Bypass -File ..\..\install.ps1 -WithDsh
~~~

手动装（等价）：

1. 把本目录复制到 `<DSH home>\profiles\node_modules\@local\printer`（目录必须叫 `printer`）
2. 在 `<DSH home>\profiles\web\cordis.patch.yml` 末尾追加：

~~~yaml
- insert:
    - id: printer
      name: '@local/printer'
      config:
        cliPath: 'C:\Users\<你>\.ai-skills\printer\src\print-cli.mjs'
~~~

3. 重启 dsh，会话里应出现 `printer_list` / `printer_print` / `printer_status`

## 配置

| 键 | 作用 | 默认 |
| --- | --- | --- |
| `cliPath` | print-cli.mjs 的绝对路径（patch 里写死最可靠） | 见下 |
| 环境变量 `AI_PRINTER_CLI` | 同上，优先级低于 `cliPath` | —— |
| 兜底 | `%USERPROFILE%\.ai-skills\printer\src\print-cli.mjs` | —— |

## 为什么一个 `@deepseek-ai/*` 都不 import

DSH 的插件目录在 `<DSH home>\profiles\node_modules\@local\`，而 `@deepseek-ai/dsh-tools`
只存在于 dsh 安装目录自己的 `node_modules` 里，从插件位置 **解析不到**
（实测 `require.resolve('@deepseek-ai/dsh-tools/package.json', { paths: [<插件目录>] })` 直接 MODULE_NOT_FOUND）。

所以这里直接构造 `ctx.tools.register()` 接受的定义对象——读 `dsh-tools/lib/index.js` 确认过它需要：

- `name` / `description` / `parameters`（原生 JSON Schema）
- `output: { schema, render }`（`render` 必须是函数；schema 走 `assertSupportedJsonSchema` 校验）
- `execute(args, exec)`，返回值必须严格符合 `output.schema`

自检脚本 `test/plugin-selftest.mjs` 会 import **真实的** `@deepseek-ai/dsh-tools`，
用它的 `assertSupportedJsonSchema` / `assertObjectJsonSchema` 校验三个 schema，
再用假 ctx 跑一遍 `execute`：

~~~powershell
node test/plugin-selftest.mjs plugin/@local/printer src/print-cli.mjs
~~~

## 返回与错误

成功：`printer_print` 返回 `{ ok, exitCode: 0, file, printer, copies, paper, landscape, dryRun, pages, outputPdf, bytes, elapsedMs, message }`。

失败：tool 抛 Error，消息形如 `print-cli failed [exit 3]: printer rejected: ...`，
其中 `exit` 就是 CLI 的退出码（2 参数 / 3 打印机 / 4 渲染 / 5 打印 / 6 安全拒绝），
模型据此决定改参数还是停下来问用户。

## 卸载

1. 删掉 `cordis.patch.yml` 里 `# >>> ai-printer-skill` 到 `# <<< ai-printer-skill <<<` 的整段
2. 把 `profiles\node_modules\@local\printer` 改名（别直接删，留个 `.removed-`）
3. 重启 dsh
