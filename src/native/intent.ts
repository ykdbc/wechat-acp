export type NativeAction =
  | { type: "contact.create"; fullName: string; phone: string; note?: string }
  | { type: "contact.lookup"; query: string }
  | { type: "contact.delete"; query: string }
  | { type: "map.lookup"; query: string };

export function parseNativeAction(text: string): NativeAction | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return parseContactCreate(trimmed)
    ?? parseContactLookup(trimmed)
    ?? parseContactDelete(trimmed)
    ?? parseMapLookup(trimmed);
}

function parseContactCreate(text: string): NativeAction | null {
  const patterns = [
    /^(?:添加|新增|加入)(.+?)(?:到|进)?通讯录(?:，|,)?(?:电话|手机号|号码)?[:： ]*([+\d][\d\s-]{5,})(?:，|,)?(?:备注[:： ]*(.+))?$/i,
    /^把(.+?)[:： ]*([+\d][\d\s-]{5,})(?:添加|加)(?:到|进)?通讯录(?:，|,)?(?:备注[:： ]*(.+))?$/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1] || !match?.[2]) continue;
    return {
      type: "contact.create",
      fullName: cleanup(match[1]),
      phone: normalizePhone(match[2]),
      note: match[3]?.trim() || undefined,
    };
  }

  const namedMatch = text.match(
    /^(?:添加|新增|加入)(?:一个)?(?:电话号码|联系人)?(?:到|进)?通讯录(?:，|,)?(?:命名为|名字叫|姓名是)(.+?)(?:，|,)?(?:电话号码|电话|手机号|号码)[:： ]*([+\d][\d\s-]{5,})(?:，|,)?(?:备注[:： ]*(.+))?$/i,
  );
  if (namedMatch?.[1] && namedMatch?.[2]) {
    return {
      type: "contact.create",
      fullName: cleanup(namedMatch[1]),
      phone: normalizePhone(namedMatch[2]),
      note: namedMatch[3]?.trim() || undefined,
    };
  }
  return null;
}

function parseContactDelete(text: string): NativeAction | null {
  const match = text.match(/^(?:删除|移除|删掉|帮我删除|帮我移除)(.+?)(?:从)?通讯录$/);
  if (!match?.[1]) return null;
  return {
    type: "contact.delete",
    query: cleanup(match[1]),
  };
}

function parseContactLookup(text: string): NativeAction | null {
  const patterns = [
    /^(?:查询一下|查一下|帮我查一下|看看)(?:联系人)?(.+?)(?:还有几个号码|有几个号码|的号码|电话|手机号|联系方式|通讯录)(?:[？?]|$)/,
    /^(?:查询|查找)(?:联系人)?(.+?)(?:[？?]|$)/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    return {
      type: "contact.lookup",
      query: cleanup(match[1]),
    };
  }
  return null;
}

function parseMapLookup(text: string): NativeAction | null {
  const match = text.match(/^(?:查询一下|查一下|帮我查一下|搜索一下|搜一下)(.+?)(?:，|,)?(?:把地图发给我|发我地图|给我地图)$/);
  if (!match?.[1]) return null;
  return {
    type: "map.lookup",
    query: cleanup(match[1]),
  };
}

function normalizePhone(value: string): string {
  return value.replace(/[^\d+]/g, "");
}

function cleanup(value: string): string {
  return value.replace(/[，。,.\s]+$/g, "").trim();
}
