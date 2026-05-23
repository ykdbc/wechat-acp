# `/opt/WeiXinBot/plus` 实现说明

这个目录现在提供了一个与主仓库解耦的“本地能力层”实现草案，目标是后续接到微信桥接层时支持：

- `日历`
  - 查
  - 增
  - 改
  - 删
- `通讯录`
  - 查
  - 增
  - 改
  - 删

## 目录结构

- [APPLE_OFFICIAL_NOTES.md](/opt/WeiXinBot/plus/APPLE_OFFICIAL_NOTES.md)
  - Apple 官方资料结论与实现边界
- [src/dav/client.ts](/opt/WeiXinBot/plus/src/dav/client.ts)
  - 通用 DAV 请求层
- [src/calendar/service.ts](/opt/WeiXinBot/plus/src/calendar/service.ts)
  - CalDAV 日历 CRUD
- [src/contacts/service.ts](/opt/WeiXinBot/plus/src/contacts/service.ts)
  - CardDAV 通讯录 CRUD
- [src/router/actions.ts](/opt/WeiXinBot/plus/src/router/actions.ts)
  - 统一动作执行入口
- [src/router/intent.ts](/opt/WeiXinBot/plus/src/router/intent.ts)
  - 微信消息到动作的自然语言解析
- [src/maps/service.ts](/opt/WeiXinBot/plus/src/maps/service.ts)
  - Apple Maps 链接生成
- [src/config.ts](/opt/WeiXinBot/plus/src/config.ts)
  - 统一配置结构
- [.env.example](/opt/WeiXinBot/plus/.env.example)
  - 环境变量模板

## 当前实现范围

- 日历：
  - 发现 calendar collection
  - 列出事件
  - 创建事件
  - 更新事件
  - 删除事件
- 通讯录：
  - 发现 address book collection
  - 列出联系人
  - 创建联系人
  - 更新联系人
  - 删除联系人
- 地图：
  - 根据自然语言地址生成 Apple Maps 查询链接
  - 适合 bot 直接回发链接

## 当前支持的消息形态

- 地图
  - `查询一下安吉县君悦国际小区，把地图发给我`
  - `搜一下杭州东站给我地图`
- 通讯录
  - `添加张三到通讯录 13800138000`
  - `新增王总进通讯录，电话 13900139000，备注 供应商`
  - `查一下张三电话`
- 日历
  - `添加日历 | 端午出行 | 2026-06-19 09:00 | 2026-06-19 18:00 | 安吉 | 检查高速是否免费`
  - 多行 `标题/开始/结束/地点/备注`
  - `给我添加明天下午3点交电费到日历`

## 变更/删除策略

- 代码层已经具备日历和通讯录的 `update/delete` 服务函数
- 但自然语言入口暂时没有直接执行“删改”
- 当前解析器会把这类句子先转成查询候选
- 这是为了避免 bot 因模糊匹配误删、误改
- 下一步应在桥接层增加“候选确认”会话后，再放开直接删改

## 当前没有做的部分

- 还没有接入微信消息自然语言意图识别
- 还没有做“上一条上下文承接”
- 还没有做“候选确认”流程
- 还没有做真实 iCloud 账号联调
- 地图还没做服务端坐标解析或静态图渲染
- 还没有处理复杂 ICS/vCard 场景
  - 例如 recurring events
  - attendees
  - alarms
  - organization / address / photo
  - 多语种属性参数

## 建议下一步

1. 在桥接层前面加一个 action router
2. 先只支持少量明确语句
3. 对修改/删除操作增加候选确认
4. 再接真实 iCloud 测试账号做端到端联调
