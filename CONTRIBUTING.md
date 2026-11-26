# 贡献指南

欢迎提 issue 和 PR。这个项目主张「小、稳、不吓人」：

1. **零运行时依赖**——不要再引入 npm 包到运行路径（开发脚本除外）
2. **打印安全第一**——任何新功能都不能绕过白名单、可执行文件拦截、页数/份数上限
3. **改动要带证据**——提交说明里写清实测数据和失败场景
4. **.ps1 必须 UTF-8 with BOM**——否则中文在 Windows PowerShell 5.1 下会乱码（CI 会检查）

## 开发

```powershell
git clone https://github.com/<you>/ai-printer-skill.git
cd ai-printer-skill
node src\print-cli.mjs status          # 不需要安装就能跑
node test\run-tests.mjs                # 需要本机有 "Microsoft Print to PDF"
```

## 提交 PR 前

- `node --check` 全部 .mjs 通过
- 所有 .ps1 语法通过且带 BOM
- 测试只打 `Microsoft Print to PDF`，不要把真机加入测试
