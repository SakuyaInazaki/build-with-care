# 标题解码动效与系统字体

日期：2026-09-05。

- 用户提出尝试 https://github.com/ics-ikeda/shuffle-text，并建议苹方，但尚未确定字体方向。
- 新增 `shuffle-text@0.6.0`（MIT）作为前端依赖，仅用于首页短标题的一次入场动效；不改业务状态、冻结需求或执行门禁。
- 动画时长 480 ms，使用全角字符减少中文宽度跳动；静态文本保留布局空间及读屏语义，动画层 `aria-hidden`。
- 尊重 `prefers-reduced-motion`，切换偏好立即结束，组件卸载取消动画；动效不循环，不应用于要求、红卡、倒计时、证据和按钮。
- 字体为暂定、可调整的系统栈：Apple 系统字体、PingFang SC、Microsoft YaHei、sans-serif。不分发或下载苹方字体文件，不把用户未确定的建议当成冻结要求。
