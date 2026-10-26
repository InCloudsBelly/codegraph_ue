# UE 图谱的增量维护与发布保护

普通工作流查询、预检、同步只维护明确存在且完整的图谱。缺库、数据库不可识别、索引不完整、文件跟踪与节点数据仅一侧非空、发布标记或锁尚未处理时，保留全部数据并返回需显式处理的状态，不自动初始化或重建。首次初始化也需要明确的维护计划及授权。

显式 `init` 不覆盖已有数据库、WAL、SHM 或 rollback journal。需要重建时，用独立的 `CODEGRAPH_DIR=.codegraph-candidate` 构建候选，保留原库，验证后再发布。不要删除旧库来让初始化继续。

`scripts/publish-validated-index.cjs` 只发布已经验证的候选，不打开 SQLite、不执行同步或索引。Windows 下先拒绝正在运行或命令行无法确认的 Node/CodeGraph 消费者，再同时持有正式库和候选库的协作锁。发布前核对验证记录、数据库身份和时间戳，旧库移动到唯一备份目录。

```powershell
node scripts/publish-validated-index.cjs --project-root E:\project --index-directory .codegraph --candidate-directory .codegraph-candidate --validation E:\evidence\validation.json
```

验证记录包含 `verified: true`、精确 `projectRoot`、`candidateDirectory`，以及 `formal` 和 `candidate` 各自的 `size`、`.NET UTC mtimeTicks`。调用方还须在发布前核验图谱内容、源码新鲜度及实际默认后端的精确身份；此文件事务工具不替代这些验证。

事务记录、发布标记和锁放在项目根目录，不随索引目录搬迁。SDK 初始化、打开、同步及工作流预检会识别这些保护文件。进程中断后，使用记录中的 UUID 显式恢复：

```powershell
node scripts/publish-validated-index.cjs --project-root E:\project --index-directory .codegraph --recover <事务UUID>
```

恢复不依赖当前默认 Provider，不运行索引。未提交的事务恢复原库并保留候选；已提交的事务核验发布结果并清理本事务标记。恢复自身中断后可再次执行。只有已确认退出且身份精确匹配的本事务锁能由显式恢复接管，旧锁另存为证据。未知标记、目录变化、不可读状态、活跃进程或无法确认的进程均停止处理，不猜测和覆盖。

这些保护要求消费者使用本版本 SDK 和工作流。已运行的旧版消费者或不参与锁协议的外部写者仍应由操作者关闭；命令行检查不能证明任意自定义 SDK 宿主都已退出。自动化覆盖的是进程退出和文件操作失败，不构成断电、文件系统损坏或存储设备持久性的保证。备份和旧版本不会自动删除。
