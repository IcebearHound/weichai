// 冒烟验证 Java 目标侧 runner(离线 fixture 用):以全限定名调用 MimeUtility.decodeText 并输出统一 JSON 协议。
// 入口文件固定为 SmokeRunner.java(public class + main);被测类 MimeUtility.java 随 sourceFiles 一起编译。
public class SmokeRunner {
    public static void main(String[] args) {
        System.out.println(results(
            entry("plain", "hello world"),
            entry("encoded-b", "=?UTF-8?B?aGVsbG8=?="),
            entry("encoded-q", "=?UTF-8?Q?hello=20world?="),
            entry("invalid-charset", "=?NOT-A-CHARSET?B?aGVsbG8=?="),
            entry("null-input", null)
        ));
    }

    static String entry(String id, String input) {
        try {
            String value = org.apache.commons.fileupload.util.mime.MimeUtility.decodeText(input);
            return "{\"caseId\":\"" + id + "\",\"outcome\":\"return\",\"returnValue\":{\"type\":\"string\",\"value\":\"" + jsonEscape(value) + "\"}}";
        } catch (Throwable t) {
            return "{\"caseId\":\"" + id + "\",\"outcome\":\"exception\",\"exceptionType\":\"" + t.getClass().getSimpleName() + "\",\"exceptionMessage\":\"" + jsonEscape(t.getMessage()) + "\"}";
        }
    }

    static String results(String... entries) {
        StringBuilder sb = new StringBuilder("{\"results\":[");
        for (int i = 0; i < entries.length; i++) {
            if (i > 0) sb.append(',');
            sb.append(entries[i]);
        }
        return sb.append("]}").toString();
    }

    static String jsonEscape(String s) {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.toString();
    }
}
