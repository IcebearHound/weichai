// Agent-curated source input for E2E stage D (DISTINCT 双侧共享缺陷演示)。
// 缺陷源方法:isSimpleNumber 不校验最后一位(个位)字符——循环条件 i < s.Length - 1
// 跳过末位;且 s.Length > 1 使单字符 "0" 返回 false。需求要求 "0" 是简单数字(返回 true),
// 含非数字字符的串(即使非数字在末位)返回 false。该实现与需求相悖(缺陷)。
using System;

public static class SimpleNumber
{
    // 缺陷:最后一位(个位)未参与校验;单字符 "0" 被判为 false(需求要求 true)。
    public static bool IsSimpleNumber(string s)
    {
        if (string.IsNullOrEmpty(s)) return false;
        for (int i = 0; i < s.Length - 1; i++)
        {
            if (s[i] < '0' || s[i] > '9') return false;
        }
        return s.Length > 1;
    }
}
