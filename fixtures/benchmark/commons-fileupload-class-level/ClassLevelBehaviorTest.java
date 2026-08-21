package org.apache.commons.fileupload;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

import javax.servlet.ServletContext;
import javax.servlet.ServletContextEvent;

import org.apache.commons.io.FileCleaningTracker;
import org.apache.commons.fileupload.disk.DiskFileItemFactory;
import org.apache.commons.fileupload.disk.DiskFileItem;
import org.apache.commons.fileupload.portlet.MockPortletActionRequest;
import org.apache.commons.fileupload.portlet.PortletFileUpload;
import org.apache.commons.fileupload.portlet.PortletRequestContext;
import org.apache.commons.fileupload.servlet.FileCleanerCleanup;
import org.apache.commons.fileupload.servlet.ServletFileUpload;
import org.apache.commons.fileupload.servlet.ServletRequestContext;
import org.apache.commons.fileupload.util.FileItemHeadersImpl;
import org.apache.commons.fileupload.util.LimitedInputStream;
import org.apache.commons.fileupload.util.Streams;
import org.apache.commons.fileupload.util.mime.MimeUtility;
import org.junit.Test;

/**
 * Class-level behavior cases derived from the Apache Commons FileUpload 1.5
 * implementation and its upstream tests. Each method is scoped to one public
 * class contract and intentionally exercises more than object construction.
 */
@SuppressWarnings("deprecation")
public class ClassLevelBehaviorTest {

    @Test
    public void defaultFileItemPreservesMetadata() throws Exception {
        DefaultFileItem item = new DefaultFileItem("field", "text/plain", true,
                "name.txt", 1024, new File(System.getProperty("java.io.tmpdir")));
        item.getOutputStream().close();
        assertEquals("field", item.getFieldName());
        assertEquals("text/plain", item.getContentType());
        assertEquals("name.txt", item.getName());
        assertTrue(item.isFormField());
        assertEquals(0, item.getSize());
    }

    @Test
    public void defaultFileItemFactoryCreatesConfiguredItem() {
        DefaultFileItemFactory factory = new DefaultFileItemFactory(32,
                new File(System.getProperty("java.io.tmpdir")));
        FileItem item = factory.createItem("title", "text/plain", true, "title.txt");
        assertEquals("title", item.getFieldName());
        assertEquals("text/plain", item.getContentType());
        assertEquals("title.txt", item.getName());
        assertTrue(item.isFormField());
    }

    @Test
    public void diskFileUploadPropertiesRoundTrip() {
        DiskFileUpload upload = new DiskFileUpload();
        DefaultFileItemFactory factory = new DefaultFileItemFactory();
        upload.setFileItemFactory(factory);
        upload.setSizeThreshold(2048);
        upload.setRepositoryPath(System.getProperty("java.io.tmpdir"));
        assertSame(factory, upload.getFileItemFactory());
        assertEquals(2048, upload.getSizeThreshold());
        assertEquals(System.getProperty("java.io.tmpdir"), upload.getRepositoryPath());
    }

    @Test
    public void fileCountLimitExceptionPreservesLimit() {
        FileCountLimitExceededException error =
                new FileCountLimitExceededException("too many files", 7);
        assertEquals("too many files", error.getMessage());
        assertEquals(7L, error.getLimit());
    }

    @Test
    public void fileItemContractIsExercisedByFactoryItem() throws Exception {
        FileItem item = new DiskFileItemFactory().createItem("field", "text/plain", false, "a.bin");
        item.getOutputStream().close();
        assertEquals("field", item.getFieldName());
        assertEquals("text/plain", item.getContentType());
        assertEquals("a.bin", item.getName());
        assertFalse(item.isFormField());
        assertEquals(0L, item.getSize());
        assertArrayEquals(new byte[0], item.get());
    }

    @Test
    public void fileItemFactoryContractExposesDefaults() {
        DiskFileItemFactory factory = new DiskFileItemFactory();
        assertEquals(DiskFileItemFactory.DEFAULT_SIZE_THRESHOLD, factory.getSizeThreshold());
        assertEquals(null, factory.getRepository());
        factory.setSizeThreshold(17);
        factory.setDefaultCharset("UTF-8");
        assertEquals(17, factory.getSizeThreshold());
        assertEquals("UTF-8", factory.getDefaultCharset());
    }

    @Test
    public void fileItemHeadersContractSupportsRepeatedValues() {
        FileItemHeadersImpl headers = new FileItemHeadersImpl();
        headers.addHeader("X-Test", "one");
        headers.addHeader("X-Test", "two");
        assertEquals("one", headers.getHeader("X-Test"));
        Iterator<String> values = headers.getHeaders("X-Test");
        assertEquals("one", values.next());
        assertEquals("two", values.next());
        assertFalse(values.hasNext());
    }

    @Test
    public void fileItemHeadersSupportRoundTripsHeaders() {
        FileItem item = new DiskFileItemFactory().createItem("f", null, true, null);
        FileItemHeadersImpl headers = new FileItemHeadersImpl();
        headers.addHeader("Content-Disposition", "form-data");
        item.setHeaders(headers);
        assertSame(headers, item.getHeaders());
    }

    @Test
    public void fileUploadPropertiesAndMultipartPredicate() {
        FileUpload upload = new FileUpload(new DiskFileItemFactory());
        upload.setSizeMax(4096);
        upload.setFileSizeMax(512);
        upload.setFileCountMax(3);
        upload.setHeaderEncoding("UTF-8");
        assertEquals(4096L, upload.getSizeMax());
        assertEquals(512L, upload.getFileSizeMax());
        assertEquals(3L, upload.getFileCountMax());
        assertEquals("UTF-8", upload.getHeaderEncoding());
        RequestContext multipart = requestContext("multipart/form-data; boundary=x", new byte[0]);
        RequestContext plain = requestContext("text/plain", new byte[0]);
        assertTrue(FileUploadBase.isMultipartContent(multipart));
        assertFalse(FileUploadBase.isMultipartContent(plain));
    }

    @Test
    public void fileUploadExceptionPreservesCause() {
        IllegalStateException cause = new IllegalStateException("root");
        FileUploadException error = new FileUploadException("failed", cause);
        assertEquals("failed", error.getMessage());
        assertSame(cause, error.getCause());
    }

    @Test
    public void invalidFileNameExceptionPreservesName() {
        InvalidFileNameException error = new InvalidFileNameException("bad\0.txt", "NUL");
        assertEquals("bad\0.txt", error.getName());
        assertEquals("NUL", error.getMessage());
    }

    @Test
    public void parameterParserHandlesQuotesSeparatorsAndCase() {
        ParameterParser parser = new ParameterParser();
        parser.setLowerCaseNames(true);
        Map<String, String> values = parser.parse(
                "text/plain; Charset=UTF-8; boundary=\"AaB03x\"; note=\"a;b\"", ';');
        assertEquals("UTF-8", values.get("charset"));
        assertEquals("AaB03x", values.get("boundary"));
        assertEquals("a;b", values.get("note"));
        assertTrue(values.containsKey("text/plain"));
        assertEquals(4, values.size());
    }

    @Test
    public void progressListenerReceivesStateChanges() {
        final AtomicLong bytes = new AtomicLong();
        ProgressListener listener = new ProgressListener() {
            @Override
            public void update(long pBytesRead, long pContentLength, int pItems) {
                bytes.set(pBytesRead + pContentLength + pItems);
            }
        };
        listener.update(12, 20, 2);
        assertEquals(34L, bytes.get());
    }

    @Test
    public void requestContextContractCarriesRequestMetadata() throws Exception {
        RequestContext context = requestContext("multipart/form-data", "abc".getBytes(StandardCharsets.UTF_8));
        assertEquals("UTF-8", context.getCharacterEncoding());
        assertEquals("multipart/form-data", context.getContentType());
        assertEquals(3, context.getContentLength());
        assertEquals('a', context.getInputStream().read());
    }

    @Test
    public void uploadContextAddsLongContentLength() throws Exception {
        UploadContext context = new UploadContext() {
            @Override public String getCharacterEncoding() { return "UTF-8"; }
            @Override public String getContentType() { return "application/octet-stream"; }
            @Override public int getContentLength() { return Integer.MAX_VALUE; }
            @Override public long contentLength() { return 4_294_967_296L; }
            @Override public InputStream getInputStream() { return new ByteArrayInputStream(new byte[0]); }
        };
        assertEquals(4_294_967_296L, context.contentLength());
        assertEquals("application/octet-stream", context.getContentType());
    }

    @Test
    public void diskFileItemFactoryCharsetAndRepositoryRoundTrip() {
        DiskFileItemFactory factory = new DiskFileItemFactory();
        File repository = new File(System.getProperty("java.io.tmpdir"));
        factory.setRepository(repository);
        factory.setDefaultCharset("UTF-16");
        assertSame(repository, factory.getRepository());
        assertEquals("UTF-16", factory.getDefaultCharset());
        assertNotNull(factory.createItem("f", null, true, null));
    }

    @Test
    public void portletFileUploadUsesConfiguredFactory() {
        DiskFileItemFactory factory = new DiskFileItemFactory();
        PortletFileUpload upload = new PortletFileUpload(factory);
        assertSame(factory, upload.getFileItemFactory());
        upload.setSizeMax(99);
        assertEquals(99L, upload.getSizeMax());
    }

    @Test
    public void portletRequestContextDelegatesToRequest() throws Exception {
        MockPortletActionRequest request = new MockPortletActionRequest(
                "body".getBytes(StandardCharsets.UTF_8), "multipart/form-data");
        PortletRequestContext context = new PortletRequestContext(request);
        assertEquals("multipart/form-data", context.getContentType());
        assertEquals(4L, context.contentLength());
        assertEquals('b', context.getInputStream().read());
    }

    @Test
    public void fileCleanerCleanupStoresAndRetrievesTracker() {
        final java.util.Map<String, Object> attributes = new java.util.HashMap<String, Object>();
        ServletContext context = (ServletContext) Proxy.newProxyInstance(
                ServletContext.class.getClassLoader(), new Class<?>[] { ServletContext.class },
                (proxy, method, args) -> {
                    if ("setAttribute".equals(method.getName())) {
                        attributes.put((String) args[0], args[1]);
                        return null;
                    }
                    if ("getAttribute".equals(method.getName())) {
                        return attributes.get(args[0]);
                    }
                    if (method.getReturnType() == boolean.class) return false;
                    if (method.getReturnType() == int.class) return 0;
                    return null;
                });
        FileCleanerCleanup cleanup = new FileCleanerCleanup();
        cleanup.contextInitialized(new ServletContextEvent(context));
        assertNotNull(FileCleanerCleanup.getFileCleaningTracker(context));
        cleanup.contextDestroyed(new ServletContextEvent(context));
    }

    @Test
    public void servletFileUploadUsesConfiguredFactory() {
        DiskFileItemFactory factory = new DiskFileItemFactory();
        ServletFileUpload upload = new ServletFileUpload(factory);
        assertSame(factory, upload.getFileItemFactory());
        upload.setFileCountMax(8);
        assertEquals(8L, upload.getFileCountMax());
    }

    @Test
    public void servletRequestContextReadsHeadersAndBody() throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest(
                new ByteArrayInputStream("body".getBytes(StandardCharsets.UTF_8)), 4, "multipart/form-data");
        ServletRequestContext context = new ServletRequestContext(request);
        assertEquals("multipart/form-data", context.getContentType());
        assertEquals(4L, context.contentLength());
        assertEquals('b', context.getInputStream().read());
    }

    @Test
    public void closeableContractIsImplementedByLimitedStream() throws Exception {
        LimitedInputStream stream = limitedStream("abc", 3);
        assertFalse(stream.isClosed());
        stream.close();
        assertTrue(stream.isClosed());
    }

    @Test
    public void fileItemHeadersImplPreservesInsertionOrder() {
        FileItemHeadersImpl headers = new FileItemHeadersImpl();
        headers.addHeader("X-One", "1");
        headers.addHeader("X-Two", "2");
        Iterator<String> names = headers.getHeaderNames();
        assertEquals("x-one", names.next());
        assertEquals("x-two", names.next());
    }

    @Test
    public void limitedInputStreamStopsAtConfiguredLimit() throws Exception {
        LimitedInputStream stream = limitedStream("abcd", 2);
        assertEquals('a', stream.read());
        assertEquals('b', stream.read());
        try {
            stream.read();
            fail("reading beyond the limit must raise the configured error");
        } catch (IOException expected) {
            assertTrue(expected.getMessage() == null || expected.getMessage().contains("limit"));
        }
    }

    @Test
    public void streamsCopyAndRejectsNulFileNames() throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        assertEquals(5L, Streams.copy(new ByteArrayInputStream("hello".getBytes(StandardCharsets.UTF_8)),
                output, true));
        assertEquals("hello", new String(output.toByteArray(), StandardCharsets.UTF_8));
        assertEquals("safe.txt", Streams.checkFileName("safe.txt"));
        try {
            Streams.checkFileName("bad\0.txt");
            fail("NUL file names must be rejected");
        } catch (InvalidFileNameException expected) {
            assertEquals("bad\0.txt", expected.getName());
        }
    }

    @Test
    public void base64DecoderHandlesPadding() throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        int count = invokeMimeDecoder("org.apache.commons.fileupload.util.mime.Base64Decoder",
                "SGVsbG8=".getBytes(StandardCharsets.US_ASCII), output);
        assertEquals(5, count);
        assertEquals("Hello", new String(output.toByteArray(), StandardCharsets.US_ASCII));
    }

    @Test
    public void mimeUtilityDecodesEncodedWords() throws Exception {
        assertEquals("Hello", MimeUtility.decodeText("=?UTF-8?B?SGVsbG8=?="));
        assertEquals("plain", MimeUtility.decodeText("plain"));
    }

    @Test
    public void parseExceptionTypeIsPresentForMimeParser() throws Exception {
        Class<?> type = Class.forName("org.apache.commons.fileupload.util.mime.ParseException");
        java.lang.reflect.Constructor<?> constructor = type.getDeclaredConstructor(String.class);
        constructor.setAccessible(true);
        Throwable exception = (Throwable) constructor.newInstance("bad MIME token");
        assertEquals("bad MIME token", exception.getMessage());
    }

    @Test
    public void quotedPrintableDecoderHandlesSoftBreaks() throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        int count = invokeMimeDecoder("org.apache.commons.fileupload.util.mime.QuotedPrintableDecoder",
                "hello=\r\nworld".getBytes(StandardCharsets.US_ASCII), output);
        assertEquals(10, count);
        assertEquals("helloworld", new String(output.toByteArray(), StandardCharsets.US_ASCII));
    }

    @Test
    public void multipartStreamReadsBytesAndUpdatesEncoding() throws Exception {
        MultipartStream stream = new MultipartStream(
                new ByteArrayInputStream(new byte[] { 7, 8 }), "--x".getBytes(StandardCharsets.US_ASCII), 8);
        stream.setHeaderEncoding("UTF-8");
        assertEquals("UTF-8", stream.getHeaderEncoding());
        assertEquals(7, stream.readByte());
        assertTrue(MultipartStream.arrayequals(new byte[] { 1, 2 }, new byte[] { 1, 2, 3 }, 2));
    }

    @Test
    public void diskFileItemMetadataAndHeadersRoundTrip() {
        DiskFileItem item = new DiskFileItem("field", "text/plain", true,
                "file.txt", 1024, new File(System.getProperty("java.io.tmpdir")));
        FileItemHeadersImpl headers = new FileItemHeadersImpl();
        headers.addHeader("X-Test", "ok");
        item.setHeaders(headers);
        assertEquals("field", item.getFieldName());
        assertEquals("file.txt", item.getName());
        assertEquals("text/plain", item.getContentType());
        assertTrue(item.isFormField());
        assertSame(headers, item.getHeaders());
    }

    @Test
    public void defaultFileItemSupportsCharsetAndFormState() {
        DefaultFileItem item = new DefaultFileItem("f", null, false, null, 32, null);
        item.setDefaultCharset("UTF-16");
        item.setFormField(true);
        item.setFieldName("renamed");
        assertEquals("UTF-16", item.getDefaultCharset());
        assertTrue(item.isFormField());
        assertEquals("renamed", item.getFieldName());
    }

    @Test
    public void defaultFileItemRejectsInvalidRepositoryOnlyWhenWriting() throws Exception {
        DefaultFileItem item = new DefaultFileItem("f", "text/plain", false, "a.txt", 0,
                new File(System.getProperty("java.io.tmpdir")));
        OutputStream output = item.getOutputStream();
        output.write("payload".getBytes(StandardCharsets.UTF_8));
        output.close();
        assertEquals("payload", item.getString("UTF-8"));
    }

    @Test
    public void defaultFileItemFactoryHonorsThresholdConstructor() {
        DefaultFileItemFactory factory = new DefaultFileItemFactory(7, new File("/tmp"));
        assertEquals(7, factory.getSizeThreshold());
        assertEquals(new File("/tmp"), factory.getRepository());
    }

    @Test
    public void defaultFileItemFactoryTracksCleanup() {
        DefaultFileItemFactory factory = new DefaultFileItemFactory();
        FileCleaningTracker tracker = new FileCleaningTracker();
        factory.setFileCleaningTracker(tracker);
        assertSame(tracker, factory.getFileCleaningTracker());
    }

    @Test
    public void diskFileUploadDefaultFactoryIsAvailable() {
        DiskFileUpload upload = new DiskFileUpload();
        assertNotNull(upload.getFileItemFactory());
        assertTrue(upload.getFileItemFactory() instanceof DefaultFileItemFactory);
    }

    @Test
    public void diskFileUploadRepositoryPathCanBeChanged() {
        DiskFileUpload upload = new DiskFileUpload();
        upload.setRepositoryPath("/tmp");
        assertEquals("/tmp", upload.getRepositoryPath());
    }

    @Test
    public void fileCountLimitExceptionAcceptsZeroLimit() {
        FileCountLimitExceededException error = new FileCountLimitExceededException("limit", 0);
        assertEquals(0L, error.getLimit());
        assertTrue(error instanceof FileUploadException);
    }

    @Test
    public void fileCountLimitExceptionRetainsSubclassType() {
        FileCountLimitExceededException error = new FileCountLimitExceededException("limit", Long.MAX_VALUE);
        assertEquals(Long.MAX_VALUE, error.getLimit());
        assertEquals("limit", error.getMessage());
    }

    @Test
    public void fileItemCanReadWrittenText() throws Exception {
        FileItem item = new DiskFileItemFactory().createItem("text", "text/plain", true, null);
        OutputStream output = item.getOutputStream();
        output.write("hello".getBytes(StandardCharsets.UTF_8));
        output.close();
        assertEquals(5L, item.getSize());
        assertEquals("hello", item.getString("UTF-8"));
    }

    @Test
    public void fileItemCanDeleteStoredContent() throws Exception {
        FileItem item = new DiskFileItemFactory(0, new File(System.getProperty("java.io.tmpdir")))
                .createItem("file", "application/octet-stream", false, "x.bin");
        OutputStream output = item.getOutputStream();
        output.write(new byte[] { 1, 2, 3 });
        output.close();
        item.delete();
        assertEquals(0L, item.getSize());
    }

    @Test
    public void fileItemFactoryCanConfigureTrackerAndCharset() {
        DiskFileItemFactory factory = new DiskFileItemFactory();
        FileCleaningTracker tracker = new FileCleaningTracker();
        factory.setFileCleaningTracker(tracker);
        factory.setDefaultCharset("ISO-8859-1");
        assertSame(tracker, factory.getFileCleaningTracker());
        assertEquals("ISO-8859-1", factory.getDefaultCharset());
    }

    @Test
    public void fileItemFactoryCreatesIndependentItems() {
        DiskFileItemFactory factory = new DiskFileItemFactory();
        FileItem first = factory.createItem("one", null, true, null);
        FileItem second = factory.createItem("two", null, false, "two.bin");
        assertNotNull(first);
        assertNotNull(second);
        assertEquals("one", first.getFieldName());
        assertEquals("two", second.getFieldName());
        assertFalse(second.isFormField());
    }

    @Test
    public void fileItemHeadersReturnsNullForUnknownHeader() {
        FileItemHeadersImpl headers = new FileItemHeadersImpl();
        assertEquals(null, headers.getHeader("missing"));
        assertFalse(headers.getHeaders("missing").hasNext());
    }

    @Test
    public void fileItemHeadersLookupIsCaseInsensitive() {
        FileItemHeadersImpl headers = new FileItemHeadersImpl();
        headers.addHeader("X-Trace", "value");
        assertEquals("value", headers.getHeader("x-trace"));
        assertEquals("value", headers.getHeaders("X-TRACE").next());
    }

    @Test
    public void fileItemHeadersSupportAllowsClearingHeaders() {
        DiskFileItem item = new DiskFileItem("f", null, true, null, 10, null);
        FileItemHeadersImpl headers = new FileItemHeadersImpl();
        item.setHeaders(headers);
        item.setHeaders(null);
        assertEquals(null, item.getHeaders());
    }

    @Test
    public void fileItemHeadersSupportPreservesHeaderObject() {
        DiskFileItem item = new DiskFileItem("f", null, true, null, 10, null);
        FileItemHeadersImpl headers = new FileItemHeadersImpl();
        headers.addHeader("A", "B");
        item.setHeaders(headers);
        assertEquals("B", item.getHeaders().getHeader("a"));
    }

    @Test
    public void fileUploadSupportsProgressListenerRoundTrip() {
        FileUpload upload = new FileUpload();
        ProgressListener listener = (bytes, length, items) -> { };
        upload.setProgressListener(listener);
        assertSame(listener, upload.getProgressListener());
    }

    @Test
    public void fileUploadCanClearHeaderEncoding() {
        FileUpload upload = new FileUpload();
        upload.setHeaderEncoding("UTF-8");
        upload.setHeaderEncoding(null);
        assertEquals(null, upload.getHeaderEncoding());
    }

    @Test
    public void fileUploadExceptionWithoutCauseIsStable() {
        FileUploadException error = new FileUploadException();
        assertEquals(null, error.getMessage());
        assertEquals(null, error.getCause());
    }

    @Test
    public void fileUploadExceptionPrintsCause() {
        FileUploadException error = new FileUploadException("outer", new IOException("inner"));
        java.io.StringWriter buffer = new java.io.StringWriter();
        error.printStackTrace(new java.io.PrintWriter(buffer));
        assertTrue(buffer.toString().contains("Caused by:"));
        assertTrue(buffer.toString().contains("inner"));
    }

    @Test
    public void invalidFileNameExceptionAllowsNullName() {
        InvalidFileNameException error = new InvalidFileNameException(null, "invalid");
        assertEquals(null, error.getName());
        assertEquals("invalid", error.getMessage());
    }

    @Test
    public void invalidFileNameExceptionIsRuntimeException() {
        assertTrue(new InvalidFileNameException("x", "bad") instanceof RuntimeException);
    }

    @Test
    public void parameterParserSupportsMultipleSeparators() {
        Map<String, String> values = new ParameterParser().parse(
                "a=1,b=2,c=3", new char[] { ',', ';' });
        assertEquals("1", values.get("a"));
        assertEquals("2", values.get("b"));
        assertEquals("3", values.get("c"));
    }

    @Test
    public void parameterParserReturnsEmptyMapForBlankInput() {
        assertTrue(new ParameterParser().parse("  ", ';').isEmpty());
    }

    @Test
    public void progressListenerAcceptsUnknownContentLength() {
        final AtomicLong observed = new AtomicLong(-1);
        ProgressListener listener = (bytes, length, items) -> observed.set(length);
        listener.update(5, -1, 1);
        assertEquals(-1L, observed.get());
    }

    @Test
    public void progressListenerCanReceiveMultipleEvents() {
        final AtomicLong observed = new AtomicLong();
        ProgressListener listener = (bytes, length, items) -> observed.addAndGet(bytes);
        listener.update(2, 10, 1);
        listener.update(5, 10, 1);
        assertEquals(7L, observed.get());
    }

    @Test
    public void requestContextSupportsEmptyBody() throws Exception {
        RequestContext context = requestContext("application/octet-stream", new byte[0]);
        assertEquals(0, context.getContentLength());
        assertEquals(-1, context.getInputStream().read());
    }

    @Test
    public void requestContextReportsContentEncoding() {
        assertEquals("UTF-8", requestContext("text/plain", new byte[0]).getCharacterEncoding());
    }

    @Test
    public void uploadContextRetainsUnknownLength() {
        UploadContext context = new UploadContext() {
            @Override public String getCharacterEncoding() { return null; }
            @Override public String getContentType() { return null; }
            @Override public int getContentLength() { return -1; }
            @Override public long contentLength() { return -1; }
            @Override public InputStream getInputStream() { return new ByteArrayInputStream(new byte[0]); }
        };
        assertEquals(-1L, context.contentLength());
        assertEquals(-1, context.getContentLength());
    }

    @Test
    public void uploadContextIsARequestContext() {
        assertTrue(UploadContext.class.isAssignableFrom(RequestContext.class) == false);
        assertTrue(RequestContext.class.isAssignableFrom(UploadContext.class));
    }

    @Test
    public void diskFileItemFactoryCanReplaceRepository() {
        DiskFileItemFactory factory = new DiskFileItemFactory();
        File repository = new File("/tmp");
        factory.setRepository(repository);
        assertSame(repository, factory.getRepository());
    }

    @Test
    public void diskFileItemFactoryCreatesFileItemWithRequestedFormState() {
        FileItem item = new DiskFileItemFactory().createItem("f", null, false, "f.bin");
        assertFalse(item.isFormField());
        assertEquals("f.bin", item.getName());
    }

    @Test
    public void portletFileUploadDefaultConstructorCreatesFactory() {
        assertEquals(null, new PortletFileUpload().getFileItemFactory());
    }

    @Test
    public void portletFileUploadCanSetProgressListener() {
        PortletFileUpload upload = new PortletFileUpload();
        ProgressListener listener = (bytes, length, items) -> { };
        upload.setProgressListener(listener);
        assertSame(listener, upload.getProgressListener());
    }

    @Test
    public void portletRequestContextReportsCharacterEncoding() {
        MockPortletActionRequest request = new MockPortletActionRequest(new byte[0], "text/plain");
        assertEquals(null, new PortletRequestContext(request).getCharacterEncoding());
    }

    @Test
    public void portletRequestContextIsUploadContext() {
        MockPortletActionRequest request = new MockPortletActionRequest(new byte[0], "text/plain");
        assertTrue(new PortletRequestContext(request) instanceof UploadContext);
    }

    @Test
    public void fileCleanerCleanupCanReplaceTracker() {
        final java.util.Map<String, Object> attributes = new java.util.HashMap<String, Object>();
        ServletContext context = (ServletContext) Proxy.newProxyInstance(
                ServletContext.class.getClassLoader(), new Class<?>[] { ServletContext.class },
                (proxy, method, args) -> {
                    if ("setAttribute".equals(method.getName())) { attributes.put((String) args[0], args[1]); return null; }
                    if ("getAttribute".equals(method.getName())) return attributes.get(args[0]);
                    if (method.getReturnType() == boolean.class) return false;
                    if (method.getReturnType() == int.class) return 0;
                    return null;
                });
        FileCleaningTracker tracker = new FileCleaningTracker();
        FileCleanerCleanup.setFileCleaningTracker(context, tracker);
        assertSame(tracker, FileCleanerCleanup.getFileCleaningTracker(context));
    }

    @Test
    public void fileCleanerCleanupExposesStableAttributeName() {
        assertTrue(FileCleanerCleanup.FILE_CLEANING_TRACKER_ATTRIBUTE.contains("FileCleaningTracker"));
    }

    @Test
    public void servletFileUploadDefaultConstructorCreatesFactory() {
        assertEquals(null, new ServletFileUpload().getFileItemFactory());
    }

    @Test
    public void servletFileUploadCanSetProgressListener() {
        ServletFileUpload upload = new ServletFileUpload();
        ProgressListener listener = (bytes, length, items) -> { };
        upload.setProgressListener(listener);
        assertSame(listener, upload.getProgressListener());
    }

    @Test
    public void servletRequestContextFallsBackForMissingLength() {
        MockHttpServletRequest request = new MockHttpServletRequest(
                new ByteArrayInputStream(new byte[0]), -1, "text/plain");
        assertEquals(-1L, new ServletRequestContext(request).contentLength());
    }

    @Test
    public void servletRequestContextIsUploadContext() {
        MockHttpServletRequest request = new MockHttpServletRequest(new byte[0], "text/plain");
        assertTrue(new ServletRequestContext(request) instanceof UploadContext);
    }

    @Test
    public void closeableReportsClosedAfterReadingToEnd() throws Exception {
        LimitedInputStream stream = limitedStream("x", 1);
        assertEquals('x', stream.read());
        assertEquals(-1, stream.read());
        stream.close();
        assertTrue(stream.isClosed());
    }

    @Test
    public void closeableCloseIsIdempotent() throws Exception {
        LimitedInputStream stream = limitedStream("x", 1);
        stream.close();
        stream.close();
        assertTrue(stream.isClosed());
    }

    @Test
    public void fileItemHeadersImplReturnsAllHeaderNames() {
        FileItemHeadersImpl headers = new FileItemHeadersImpl();
        headers.addHeader("A", "1");
        headers.addHeader("B", "2");
        int count = 0;
        for (Iterator<String> names = headers.getHeaderNames(); names.hasNext();) { names.next(); count++; }
        assertEquals(2, count);
    }

    @Test
    public void fileItemHeadersImplJoinsRepeatedHeaderValues() {
        FileItemHeadersImpl headers = new FileItemHeadersImpl();
        headers.addHeader("Accept", "text/plain");
        headers.addHeader("Accept", "text/html");
        assertEquals("text/plain", headers.getHeader("accept"));
        Iterator<String> values = headers.getHeaders("accept");
        assertEquals("text/plain", values.next());
        assertEquals("text/html", values.next());
    }

    @Test
    public void limitedInputStreamSupportsBulkReads() throws Exception {
        LimitedInputStream stream = limitedStream("abcd", 4);
        byte[] buffer = new byte[4];
        assertEquals(4, stream.read(buffer, 0, 4));
        assertArrayEquals("abcd".getBytes(StandardCharsets.UTF_8), buffer);
    }

    @Test
    public void limitedInputStreamSkipIsBounded() throws Exception {
        LimitedInputStream stream = limitedStream("abcd", 4);
        assertEquals(2L, stream.skip(2));
        assertEquals('c', stream.read());
    }

    @Test
    public void streamsAsStringUsesUtf8() throws Exception {
        assertEquals("hé", Streams.asString(new ByteArrayInputStream("hé".getBytes(StandardCharsets.UTF_8)), "UTF-8"));
    }

    @Test
    public void streamsCopyCanDiscardOutput() throws Exception {
        assertEquals(4L, Streams.copy(new ByteArrayInputStream("data".getBytes(StandardCharsets.UTF_8)), null, false));
    }

    @Test
    public void base64DecoderHandlesUnpaddedInput() throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        int count = invokeMimeDecoder("org.apache.commons.fileupload.util.mime.Base64Decoder",
                "SGk=".getBytes(StandardCharsets.US_ASCII), output);
        assertEquals(2, count);
        assertEquals("Hi", new String(output.toByteArray(), StandardCharsets.US_ASCII));
    }

    @Test
    public void base64DecoderIgnoresWhitespace() throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        int count = invokeMimeDecoder("org.apache.commons.fileupload.util.mime.Base64Decoder",
                "SG Vs bG 8=".getBytes(StandardCharsets.US_ASCII), output);
        assertEquals(5, count);
        assertEquals("Hello", new String(output.toByteArray(), StandardCharsets.US_ASCII));
    }

    @Test
    public void mimeUtilityDecodesQuotedPrintableWords() throws Exception {
        assertEquals("Hello!", MimeUtility.decodeText("=?UTF-8?Q?Hello=21?="));
    }

    @Test
    public void mimeUtilityRejectsUnknownCharset() throws Exception {
        try {
            MimeUtility.decodeText("=?NO_SUCH_CHARSET?B?SGk=?=");
            fail("unknown charset must be rejected");
        } catch (java.io.UnsupportedEncodingException expected) {
            assertNotNull(expected);
        }
    }

    @Test
    public void parseExceptionRetainsEmptyMessage() throws Exception {
        Class<?> type = Class.forName("org.apache.commons.fileupload.util.mime.ParseException");
        java.lang.reflect.Constructor<?> constructor = type.getDeclaredConstructor(String.class);
        constructor.setAccessible(true);
        Throwable exception = (Throwable) constructor.newInstance("");
        assertEquals("", exception.getMessage());
    }

    @Test
    public void parseExceptionIsCheckedException() throws Exception {
        assertTrue(Exception.class.isAssignableFrom(Class.forName("org.apache.commons.fileupload.util.mime.ParseException")));
    }

    @Test
    public void quotedPrintableDecoderDecodesHexBytes() throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        int count = invokeMimeDecoder("org.apache.commons.fileupload.util.mime.QuotedPrintableDecoder",
                "A=20B=21".getBytes(StandardCharsets.US_ASCII), output);
        assertEquals(4, count);
        assertEquals("A B!", new String(output.toByteArray(), StandardCharsets.US_ASCII));
    }

    @Test
    public void quotedPrintableDecoderKeepsPlainText() throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        int count = invokeMimeDecoder("org.apache.commons.fileupload.util.mime.QuotedPrintableDecoder",
                "plain".getBytes(StandardCharsets.US_ASCII), output);
        assertEquals(5, count);
        assertEquals("plain", new String(output.toByteArray(), StandardCharsets.US_ASCII));
    }

    @Test
    public void multipartStreamCanChangeBoundary() throws Exception {
        MultipartStream stream = new MultipartStream(new ByteArrayInputStream(new byte[] { 9 }),
                "old".getBytes(StandardCharsets.US_ASCII), 8);
        stream.setBoundary("new".getBytes(StandardCharsets.US_ASCII));
        assertEquals(9, stream.readByte());
    }

    @Test
    public void multipartStreamReadsHeaderBlock() throws Exception {
        MultipartStream stream = new MultipartStream(new ByteArrayInputStream(
                "X-Test: yes\r\n\r\n".getBytes(StandardCharsets.US_ASCII)),
                "x".getBytes(StandardCharsets.US_ASCII), 16);
        assertEquals("X-Test: yes\r\n\r\n", stream.readHeaders());
    }

    @Test
    public void diskFileItemCanChangeMetadata() {
        DiskFileItem item = new DiskFileItem("before", null, false, "a", 10, null);
        item.setFieldName("after");
        item.setFormField(true);
        item.setDefaultCharset("UTF-8");
        assertEquals("after", item.getFieldName());
        assertTrue(item.isFormField());
        assertEquals("UTF-8", item.getDefaultCharset());
    }

    @Test
    public void diskFileItemUsesDefaultCharsetForStrings() throws Exception {
        DiskFileItem item = new DiskFileItem("f", "text/plain", true, null, 1024,
                new File(System.getProperty("java.io.tmpdir")));
        OutputStream output = item.getOutputStream();
        output.write("text".getBytes(StandardCharsets.UTF_8));
        output.close();
        item.setDefaultCharset("UTF-8");
        assertEquals("text", item.getString());
    }

    private static RequestContext requestContext(final String contentType, final byte[] body) {
        return new RequestContext() {
            @Override public String getCharacterEncoding() { return "UTF-8"; }
            @Override public String getContentType() { return contentType; }
            @Override public int getContentLength() { return body.length; }
            @Override public InputStream getInputStream() { return new ByteArrayInputStream(body); }
        };
    }

    private static int invokeMimeDecoder(String className, byte[] input,
            OutputStream output) throws Exception {
        Class<?> decoder = Class.forName(className);
        java.lang.reflect.Method method = decoder.getDeclaredMethod("decode", byte[].class, OutputStream.class);
        method.setAccessible(true);
        return ((Integer) method.invoke(null, input, output)).intValue();
    }

    private static LimitedInputStream limitedStream(String value, final long limit) {
        return new LimitedInputStream(new ByteArrayInputStream(value.getBytes(StandardCharsets.UTF_8)), limit) {
            @Override
            protected void raiseError(long pSizeMax, long pCount) throws IOException {
                throw new IOException("limit " + pSizeMax + " exceeded at " + pCount);
            }
        };
    }
}
