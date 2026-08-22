// Java 翻译产物(agent 完成,作为 E2E 阶段 D 的目标侧输入)。
// 忠实镜像 C# 缺陷实现的缺陷:循环 i < s.length() - 1 跳过末位校验;
// s.length() > 1 使 "0" 返回 false —— 翻译一致但继承缺陷(双侧共享缺陷,差分全 PASS)。
package org.forexplore.samples;

public class SimpleNumber {
    public static boolean isSimpleNumber(String s) {
        if (s == null || s.isEmpty()) return false;
        for (int i = 0; i < s.length() - 1; i++) {
            if (s.charAt(i) < '0' || s.charAt(i) > '9') return false;
        }
        return s.length() > 1;
    }
}
