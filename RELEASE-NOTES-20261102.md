# CODIO — Your Private Radio · 0.1.7 Preview · 2026-11-02

## 中文

本预览更新包含截至 2026-11-02 的桌面修复与运行负担精简。中英双语介绍与 MIT 源码同步更新；旧预览保留用于回退。

- 鼠标粒子吸附复用预计算查找表，合并高频样式更新，停止更新被遮挡首页；保留立体、惯性、节拍和换歌动画。
- 推荐评分按同一批次复用公共证据和已规范化标签，减少重复运算，不改变本次精简前的评分、板块资格和选曲规则。
- 推荐卡片状态、播放列表节点不随每次播放进度和聊天计时重建。临时索引按实际工作集回收，保留可见 24 首、完整承诺队列、手动下一首与转场目标。
- 听歌记忆保留即时持久化，移除重复同步写盘；可选歌曲元数据缓存合并落盘，不阻塞已核实结果返回。
- 无有效任务的已取消/超时分析会真正终止 Worker；有共享有效任务时不误杀。移除解码前不必要的压缩音频复制。
- 包含此前的 AI DJ 明确偏好证据、真实推荐完成状态、重复刷新补充候选、QQ 恢复、搜索 NEXT 只入队、歌词恢复及启动波形源身份/时长校验修复。
- 包含提前安排音频分析、双 Deck 实际增益调度、可靠尾部静音交接和原速渐进融合改进。不会因为速度估计不同就自动退成短切；不跳过已确认的真实前奏/尾奏。

验证：771 项自动测试通过；构建与桌面资源哈希核对通过。固定合成候选实验中，600 首资料、两栏各 120 候选的评分及编排约从 362 ms 降至 149 ms，分数与结果一致。这不是整机、网络速度或实际听感提升比例。未替用户运行本轮原生试听或长时性能验收。

已知边界：保留 6 条原有 Lint 警告和 3 个 Cloudflare 模板环境类型错误。QQ 音源/授权、DeepSeek 额度/服务、歌词与 GPU 性能仍受外部条件影响。未签名 Windows 预览版，请核对 SHA-256，不要关闭系统防护。需要自行连接 QQ 音乐及可选的个人 DeepSeek Key，下载包不包含账号、Key、听歌数据或音乐文件。

## English

This preview synchronizes desktop fixes and runtime-work reductions through November 2, 2026. The bilingual README and MIT source are updated together; previous previews remain available for rollback.

- Particle attraction reuses a precomputed lookup table and coalesces pointer style updates. Covered home-page parallax no longer updates; depth, inertia, beat response and cover morphs remain.
- Recommendation batches reuse shared evidence and normalized tags without changing the scoring mathematics, lane eligibility or selection rules in this runtime refactor.
- Recommendation familiarity and queue nodes no longer rebuild on every playhead/chat tick. Disposable indexes retire unused entries while preserving 24 visible songs, committed queues, manual inserts and transition targets.
- Listening memory still saves immediately, without the duplicate synchronous write. Optional song-metadata disk snapshots are coalesced and no longer block verified IPC responses.
- Cancelled or timed-out analysis terminates its Worker only when no useful shared work remains. An unnecessary compressed-audio copy before decoding was removed.
- Includes earlier AI DJ preference provenance, actual recommendation completion reporting, repeated-refresh recovery, QQ restoration, queue-only search NEXT, lyric recovery and source/duration-bound startup waveform fixes.
- Includes earlier analysis preparation, actual dual-deck gain scheduling, reliable silent-tail handoffs and original-speed gradual blending. Tempo-estimate differences alone no longer force a short cut; confirmed musical intros/outros are retained.

Validation: 771 automated tests passed; desktop build and packaged-resource checks passed. A fixed synthetic workload of 600 library facts and 120 candidates per lane decreased from approximately 362 ms to 149 ms for scoring/composition, with identical scores and outputs. This is not an overall system, network or listening-quality improvement percentage. Native listening and long-session hardware acceptance were not performed for this release.

Known limits: six existing lint warnings and three Cloudflare-template environment-type errors remain separately reported. QQ availability/authorization, DeepSeek credit/service, lyrics and GPU performance depend on external conditions. This unsigned Windows preview requires checksum verification; do not disable system security. Connect your own QQ Music account and optional DeepSeek key. No credentials, personal listening data or music files are distributed.
