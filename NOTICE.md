# NOTICE

本项目包含或参考了以下第三方成果：

## Unlock Music Project

- 上游：`https://git.unlock-music.dev/um`（`um-react`、`lib_um_crypto_rust`）
- 许可：Apache License 2.0 / MIT（双许可）
- 使用方式：参考其公开的 QMC / NCM 格式说明、常量与测试向量，使用 TypeScript 独立重实现；未复制源代码文件。
- 相关实现位于 `src/core/qmc/`、`src/core/ncm/`、`src/core/tea.ts`、`src/core/aes128.ts`。

## tc_tea

- 腾讯 TEA（16 轮 + 定制 CBC）行为遵循 `tc_tea` crate 的公开规范。
- 本项目为独立的 TypeScript 实现（`src/core/tea.ts`）。

## 其他

- React、Vite、TypeScript 等依赖遵循其各自许可证，见 `package-lock.json` 与各包内 LICENSE。
- `tests/fixtures/` 中的样本为自建合成数据，不含任何版权音频。
