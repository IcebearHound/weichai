// Java 翻译产物(agent 完成,作为 E2E 的目标侧输入)。
// 对应 C# Base64Decoder.Decode(string → byte[])。
package org.apache.commons.fileupload.util.mime;

public class Base64Decoder {
    public static byte[] decode(String value) {
        return java.util.Base64.getDecoder().decode(value);
    }
}
