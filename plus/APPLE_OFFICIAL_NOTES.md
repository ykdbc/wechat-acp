# Apple 官方资料结论

以下结论来自 Apple 官方支持文档，用来约束 `/opt/WeiXinBot/plus` 里的实现边界。

## 已知信息

- Apple 官方明确支持第三方应用访问 `iCloud Mail / Calendar / Contacts`。
- 对支持的第三方应用，Apple 优先推荐通过 Apple Account 授权访问；如果应用不支持该授权流，可以使用 `app-specific password`。
- Apple 官方用户指南明确说明，系统和客户端支持手动添加 `CalDAV` 与 `CardDAV` 账户。
- `Calendar on iCloud.com` 支持创建、编辑事件与管理日历。
- `Contacts on iCloud.com` 支持创建、编辑、删除联系人，以及导入/导出 `vCard`。

## 对实现的直接影响

- 日历能力使用 `CalDAV` 是合理且与 Apple 官方文档一致的。
- 通讯录能力使用 `CardDAV` 是合理且与 Apple 官方文档一致的。
- 这个目录里的实现选择：
  - 首版认证方式使用 `Apple Account + app-specific password`
  - 协议实现走标准 `CalDAV / CardDAV`
  - 不直接依赖 iPhone App 或 iCloud.com Web 自动化

## 关键限制

- Apple 官方文档没有把这里需要的低层 DAV 请求样例逐条写出来。
- 因此代码中的 `PROPFIND / REPORT / PUT / DELETE` 细节，是基于 DAV 标准协议的工程实现。
- 这部分是“依据 Apple 官方确认支持 DAV，再按标准协议落地”，不是 Apple 文档逐字提供的示例代码。

## 官方来源

- [Access your iCloud Mail, Calendar, and Contacts in third-party apps](https://support.apple.com/en-us/121539)
- [Sign in to apps with your Apple Account using app-specific passwords](https://support.apple.com/en-mide/102654)
- [Set up mail, contacts, and calendar accounts on iPhone](https://support.apple.com/en-lamr/guide/iphone/ipha0d932e96/ios)
- [Use Calendar on iCloud.com](https://support.apple.com/guide/icloud/use-calendar-on-icloudcom-mmd67283e4/icloud)
- [Add and edit a calendar event on iCloud.com](https://support.apple.com/en-mide/guide/icloud/mmfbbb32be/icloud)
- [Use Contacts on iCloud.com](https://support.apple.com/en-mide/guide/icloud/mmfba7481b/icloud)
- [Create or edit contacts in Contacts on iCloud.com](https://support.apple.com/en-mide/guide/icloud/mmfba737da/icloud)
- [Delete contacts on iCloud.com](https://support.apple.com/guide/icloud/delete-contacts-mm6704c88a/icloud)
- [Limits for iCloud Contacts, Calendars, Reminders, Bookmarks, and Maps](https://support.apple.com/en-mide/103188)
