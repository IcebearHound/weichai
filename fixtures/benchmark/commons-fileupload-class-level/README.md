# Commons FileUpload 类级功能等价实验

`ClassLevelBehaviorTest.java` 是一组从 Apache Commons FileUpload 1.5 原实现和上游 JUnit 用例抽取的类级测试。每个类固定 3 个独立 `@Test`，共 93 个 TestCase，覆盖元数据、配置往返、边界输入、异常信息、状态变化和编码解码，不把整个项目的集成上传测试归因给单个类。

`manifest.json` 固定了 31 个已通过模块编译门槛的类与测试方法的对应关系。源项目先跑这 31 个测试作为 oracle；目标项目使用完全相同的测试。某类的全部关联测试通过，才计为该类功能等价。测试失败或运行错误都不计通过，不能用“未验证”替代通过。

运行：

```text
npx tsx scripts/run_class_functional_equivalence.ts
```

脚本不会修改用户给出的 Apache 源项目或翻译骨架，而是在 `/tmp/forexplore-class-functional-equivalence` 创建临时副本，结果写入其 `result.json`。
