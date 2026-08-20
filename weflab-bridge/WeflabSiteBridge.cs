using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

/// <summary>
/// Durable, one-way bridge from the v5.8 desktop collector to the Doomi site.
///
/// The WebView sends the exact rows produced by Weflab.toKarmaRows(). This
/// class stores them in a local outbox before attempting the network request,
/// batches at the site's 100-row limit, and relies on event_uid + stage for
/// idempotency at both ends.
///
/// Compatible with the .NET Framework compiler used by desktop/build.bat.
/// It intentionally has no dependency beyond System.Web.Extensions.dll.
/// </summary>
public sealed class WeflabSiteBridge : IDisposable
{
    const int MaxBatchSize = 100;
    const int InitialRetryMilliseconds = 2000;
    const int MaxRetryMilliseconds = 300000;
    const string MessagePrefix = "doomi-bridge-import:";

    readonly object _gate = new object();
    readonly AutoResetEvent _wake = new AutoResetEvent(false);
    readonly JavaScriptSerializer _json = new JavaScriptSerializer();
    readonly List<Dictionary<string, object>> _pending =
        new List<Dictionary<string, object>>();
    readonly Action<string> _log;
    readonly string _outboxPath;
    readonly string _rejectedPath;
    readonly Uri _endpoint;
    readonly string _token;
    readonly bool _enabled;

    Thread _worker;
    volatile bool _stopping;
    bool _reportedDisabled;

    WeflabSiteBridge(
        bool enabled,
        Uri endpoint,
        string token,
        string outboxPath,
        string rejectedPath,
        Action<string> log)
    {
        _enabled = enabled;
        _endpoint = endpoint;
        _token = token ?? "";
        _outboxPath = outboxPath;
        _rejectedPath = rejectedPath;
        _log = log ?? delegate { };
        _json.MaxJsonLength = Int32.MaxValue;

        if (!_enabled) return;

        LoadOutbox();
        _worker = new Thread(WorkerLoop);
        _worker.IsBackground = true;
        _worker.Name = "DoomiWeflabBridge";
        _worker.Start();
        if (_pending.Count > 0) _wake.Set();
        SafeLog("연결 준비됨 · 대기 " + _pending.Count + "건");
    }

    /// <summary>
    /// Loads %APPDATA%\RouletteKarma\doomi-site-bridge.json.
    /// DOOMI_SITE_URL and DOOMI_BRIDGE_TOKEN environment variables override
    /// the file when present. No token value is ever logged.
    /// </summary>
    public static WeflabSiteBridge StartDefault(Action<string> log)
    {
        string home = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "RouletteKarma");
        Directory.CreateDirectory(home);

        string configPath = Path.Combine(home, "doomi-site-bridge.json");
        string outboxPath = Path.Combine(home, "doomi-site-bridge.outbox.json");
        string rejectedPath = Path.Combine(home, "doomi-site-bridge.rejected.ndjson");

        var serializer = new JavaScriptSerializer();
        Dictionary<string, object> config = new Dictionary<string, object>();
        try
        {
            if (File.Exists(configPath))
            {
                config = serializer.DeserializeObject(
                    File.ReadAllText(configPath, Encoding.UTF8))
                    as Dictionary<string, object>
                    ?? new Dictionary<string, object>();
            }
        }
        catch (Exception ex)
        {
            if (log != null) log("설정 파일을 읽지 못함: " + ex.Message);
        }

        string siteUrl = Environment.GetEnvironmentVariable("DOOMI_SITE_URL");
        string token = Environment.GetEnvironmentVariable("DOOMI_BRIDGE_TOKEN");
        if (string.IsNullOrWhiteSpace(siteUrl)) siteUrl = ReadString(config, "siteUrl");
        if (string.IsNullOrWhiteSpace(token)) token = ReadString(config, "token");

        bool enabled = ReadBool(config, "enabled", true);
        string problem;
        Uri endpoint = BuildEndpoint(siteUrl, out problem);
        token = (token ?? "").Trim();

        if (token.IndexOf('\r') >= 0 || token.IndexOf('\n') >= 0)
        {
            problem = "토큰에 허용되지 않는 줄바꿈이 있습니다.";
            token = "";
        }
        if (string.IsNullOrEmpty(token)) problem = "브리지 토큰이 비어 있습니다.";
        if (!enabled) problem = "설정에서 브리지가 꺼져 있습니다.";

        bool ready = enabled && endpoint != null && !string.IsNullOrEmpty(token);
        if (!ready && log != null)
            log("비활성 · " + (string.IsNullOrEmpty(problem) ? "설정을 확인하세요." : problem));

        return new WeflabSiteBridge(
            ready, endpoint, token, outboxPath, rejectedPath, log);
    }

    /// <summary>
    /// Handles one WebView string message. Returns true when the message was
    /// addressed to this bridge, even if every row was already queued.
    /// </summary>
    public bool TryHandleWebMessage(string message)
    {
        if (string.IsNullOrEmpty(message) ||
            !message.StartsWith(MessagePrefix, StringComparison.Ordinal))
            return false;

        EnqueueJson(message.Substring(MessagePrefix.Length));
        return true;
    }

    /// <summary>
    /// Queues a JSON array in the exact v5.8 Weflab.toKarmaRows() shape.
    /// Rows without event_uid, stage, or item are ignored locally; the site
    /// performs the authoritative length/date validation.
    /// </summary>
    public void EnqueueJson(string rowsJson)
    {
        if (!_enabled)
        {
            if (!_reportedDisabled)
            {
                _reportedDisabled = true;
                SafeLog("전송 안 함 · doomi-site-bridge.json 설정 필요");
            }
            return;
        }

        object parsed;
        try { parsed = _json.DeserializeObject(rowsJson ?? "[]"); }
        catch (Exception ex)
        {
            SafeLog("행 JSON을 읽지 못함: " + ex.Message);
            return;
        }

        object[] rows = parsed as object[];
        if (rows == null)
        {
            SafeLog("행 메시지가 배열이 아님");
            return;
        }

        int added = 0;
        int invalid = 0;
        lock (_gate)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            for (int i = 0; i < _pending.Count; i++)
            {
                string existingKey = RowKey(_pending[i]);
                if (existingKey != null) seen.Add(existingKey);
            }

            for (int i = 0; i < rows.Length; i++)
            {
                var row = rows[i] as Dictionary<string, object>;
                string key = RowKey(row);
                if (key == null)
                {
                    invalid += 1;
                    continue;
                }
                if (!seen.Add(key)) continue;
                _pending.Add(row);
                added += 1;
            }

            if (added > 0) SaveOutboxLocked();
        }

        if (invalid > 0) SafeLog("형식이 다른 행 " + invalid + "건 건너뜀");
        if (added > 0)
        {
            SafeLog("업보 " + added + "건 전송 대기");
            _wake.Set();
        }
    }

    void WorkerLoop()
    {
        int retryMilliseconds = InitialRetryMilliseconds;
        while (!_stopping)
        {
            List<Dictionary<string, object>> batch = SnapshotBatch();
            if (batch.Count == 0)
            {
                _wake.WaitOne();
                continue;
            }

            PostResult result = Post(batch);
            if (result.Kind == PostResultKind.Success)
            {
                RemoveBatch(batch);
                retryMilliseconds = InitialRetryMilliseconds;
                SafeLog("전송 완료 " + batch.Count + "건");
                continue;
            }

            if (result.Kind == PostResultKind.PermanentFailure)
            {
                if (Quarantine(batch, result))
                {
                    RemoveBatch(batch);
                    retryMilliseconds = InitialRetryMilliseconds;
                    SafeLog("서버가 거절한 " + batch.Count + "건을 rejected 파일에 보관 (HTTP " +
                        result.StatusCode.ToString(CultureInfo.InvariantCulture) + ")");
                }
                else
                {
                    // Recovery copy could not be written, so keep the original
                    // batch in the durable outbox and retry later.
                    _wake.WaitOne(retryMilliseconds);
                    retryMilliseconds = Math.Min(retryMilliseconds * 2, MaxRetryMilliseconds);
                }
                continue;
            }

            SafeLog("전송 실패" +
                (result.StatusCode > 0
                    ? " HTTP " + result.StatusCode.ToString(CultureInfo.InvariantCulture)
                    : "") +
                " · 나중에 재시도");
            _wake.WaitOne(retryMilliseconds);
            retryMilliseconds = Math.Min(retryMilliseconds * 2, MaxRetryMilliseconds);
        }
    }

    List<Dictionary<string, object>> SnapshotBatch()
    {
        lock (_gate)
        {
            int count = Math.Min(MaxBatchSize, _pending.Count);
            return _pending.GetRange(0, count);
        }
    }

    PostResult Post(List<Dictionary<string, object>> batch)
    {
        byte[] body = Encoding.UTF8.GetBytes(_json.Serialize(
            new Dictionary<string, object> { { "items", batch } }));

        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(_endpoint);
        request.Method = "POST";
        request.ContentType = "application/json; charset=utf-8";
        request.Accept = "application/json";
        request.UserAgent = "RouletteKarma-DoomiBridge/1.0";
        request.Headers[HttpRequestHeader.Authorization] = "Bearer " + _token;
        // Never risk forwarding the bearer token to a redirect target. The
        // configured URL must already be the site's canonical HTTPS origin.
        request.AllowAutoRedirect = false;
        request.Timeout = 15000;
        request.ReadWriteTimeout = 15000;
        request.ContentLength = body.Length;

        try
        {
            using (Stream stream = request.GetRequestStream())
                stream.Write(body, 0, body.Length);
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                return Classify((int)response.StatusCode, ReadResponse(response));
        }
        catch (WebException ex)
        {
            HttpWebResponse response = ex.Response as HttpWebResponse;
            if (response == null) return PostResult.Transient(0, ex.Status.ToString());
            using (response)
                return Classify((int)response.StatusCode, ReadResponse(response));
        }
        catch (Exception ex)
        {
            return PostResult.Transient(0, ex.GetType().Name);
        }
    }

    static PostResult Classify(int statusCode, string response)
    {
        if (statusCode >= 200 && statusCode <= 299)
            return PostResult.Success(statusCode);

        // These statuses indicate that retrying the same rows cannot help.
        // Keep a recoverable NDJSON copy and allow later valid rows through.
        if (statusCode == 400 || statusCode == 409 ||
            statusCode == 413 || statusCode == 422)
            return PostResult.Permanent(statusCode, response);

        // Authentication, wrong URL, rate limits, and server/network failures
        // remain in the durable outbox until configuration/service recovers.
        return PostResult.Transient(statusCode, response);
    }

    static string ReadResponse(HttpWebResponse response)
    {
        try
        {
            using (Stream stream = response.GetResponseStream())
            using (var reader = new StreamReader(stream, Encoding.UTF8))
            {
                string text = reader.ReadToEnd();
                return text.Length > 1000 ? text.Substring(0, 1000) : text;
            }
        }
        catch { return ""; }
    }

    void RemoveBatch(List<Dictionary<string, object>> batch)
    {
        var keys = new HashSet<string>(StringComparer.Ordinal);
        for (int i = 0; i < batch.Count; i++)
        {
            string key = RowKey(batch[i]);
            if (key != null) keys.Add(key);
        }

        lock (_gate)
        {
            _pending.RemoveAll(delegate (Dictionary<string, object> row)
            {
                string key = RowKey(row);
                return key != null && keys.Contains(key);
            });
            SaveOutboxLocked();
        }
    }

    bool Quarantine(List<Dictionary<string, object>> batch, PostResult result)
    {
        try
        {
            var entry = new Dictionary<string, object>();
            entry["rejected_at"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture);
            entry["status"] = result.StatusCode;
            entry["response"] = result.Response ?? "";
            entry["items"] = batch;
            File.AppendAllText(
                _rejectedPath,
                _json.Serialize(entry) + Environment.NewLine,
                new UTF8Encoding(false));
            return true;
        }
        catch (Exception ex)
        {
            // Do not remove a rejected batch unless its recovery copy exists.
            // Turning this into a transient result would complicate the worker,
            // so re-add a marker log and retain the durable pre-send outbox file.
            SafeLog("rejected 보관 실패: " + ex.Message);
            return false;
        }
    }

    void LoadOutbox()
    {
        try
        {
            if (!File.Exists(_outboxPath)) return;
            object[] rows = _json.DeserializeObject(
                File.ReadAllText(_outboxPath, Encoding.UTF8)) as object[];
            if (rows == null) return;

            var seen = new HashSet<string>(StringComparer.Ordinal);
            for (int i = 0; i < rows.Length; i++)
            {
                var row = rows[i] as Dictionary<string, object>;
                string key = RowKey(row);
                if (key != null && seen.Add(key)) _pending.Add(row);
            }
        }
        catch (Exception ex)
        {
            SafeLog("기존 outbox를 읽지 못함: " + ex.Message);
        }
    }

    void SaveOutboxLocked()
    {
        try
        {
            AtomicWrite(_outboxPath, _json.Serialize(_pending));
        }
        catch (Exception ex)
        {
            SafeLog("outbox 저장 실패: " + ex.Message);
        }
    }

    static void AtomicWrite(string path, string text)
    {
        string directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
        string temporary = path + ".tmp";
        File.WriteAllText(temporary, text, new UTF8Encoding(false));
        if (!File.Exists(path))
        {
            File.Move(temporary, path);
            return;
        }

        string backup = path + ".bak";
        try { if (File.Exists(backup)) File.Delete(backup); } catch { }
        File.Replace(temporary, path, backup);
    }

    static string RowKey(Dictionary<string, object> row)
    {
        if (row == null) return null;
        string eventUid = ReadString(row, "event_uid").Trim();
        string item = ReadString(row, "item").Trim();
        object stageValue;
        if (eventUid.Length == 0 || item.Length == 0 ||
            !row.TryGetValue("stage", out stageValue)) return null;

        int stage;
        try
        {
            decimal number = Convert.ToDecimal(stageValue, CultureInfo.InvariantCulture);
            if (number != decimal.Truncate(number) || number < 0 || number > 10000)
                return null;
            stage = Decimal.ToInt32(number);
        }
        catch { return null; }

        return eventUid + ":" + stage.ToString(CultureInfo.InvariantCulture);
    }

    static Uri BuildEndpoint(string siteUrl, out string problem)
    {
        problem = "사이트 주소가 비어 있습니다.";
        if (string.IsNullOrWhiteSpace(siteUrl)) return null;

        Uri root;
        if (!Uri.TryCreate(siteUrl.Trim(), UriKind.Absolute, out root))
        {
            problem = "사이트 주소 형식이 올바르지 않습니다.";
            return null;
        }

        bool http = root.Scheme.Equals("http", StringComparison.OrdinalIgnoreCase);
        bool https = root.Scheme.Equals("https", StringComparison.OrdinalIgnoreCase);
        if (!http && !https)
        {
            problem = "사이트 주소는 http 또는 https여야 합니다.";
            return null;
        }

        bool local = root.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase) ||
                     root.Host.Equals("127.0.0.1", StringComparison.OrdinalIgnoreCase) ||
                     root.Host.Equals("::1", StringComparison.OrdinalIgnoreCase) ||
                     root.Host.EndsWith(".localhost", StringComparison.OrdinalIgnoreCase);
        if (!https && !local)
        {
            problem = "외부 사이트는 토큰 보호를 위해 https가 필요합니다.";
            return null;
        }

        var canonical = new UriBuilder(root);
        canonical.Query = "";
        canonical.Fragment = "";
        string value = canonical.Uri.ToString().TrimEnd('/');
        if (!root.AbsolutePath.TrimEnd('/').EndsWith(
                "/api/weplab/import", StringComparison.OrdinalIgnoreCase))
            value += "/api/weplab/import";

        problem = "";
        return new Uri(value, UriKind.Absolute);
    }

    static string ReadString(Dictionary<string, object> values, string key)
    {
        object value;
        return values != null && values.TryGetValue(key, out value) && value != null
            ? Convert.ToString(value, CultureInfo.InvariantCulture) ?? ""
            : "";
    }

    static bool ReadBool(Dictionary<string, object> values, string key, bool fallback)
    {
        object value;
        if (values == null || !values.TryGetValue(key, out value) || value == null)
            return fallback;
        bool parsed;
        return Boolean.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture), out parsed)
            ? parsed
            : fallback;
    }

    void SafeLog(string message)
    {
        try { _log(message ?? ""); } catch { }
    }

    public void Dispose()
    {
        if (_stopping) return;
        _stopping = true;
        _wake.Set();
        try { if (_worker != null) _worker.Join(2000); } catch { }
        _wake.Dispose();
    }

    enum PostResultKind
    {
        Success,
        PermanentFailure,
        TransientFailure
    }

    sealed class PostResult
    {
        public PostResultKind Kind;
        public int StatusCode;
        public string Response;

        public static PostResult Success(int status)
        {
            return new PostResult { Kind = PostResultKind.Success, StatusCode = status };
        }

        public static PostResult Permanent(int status, string response)
        {
            return new PostResult {
                Kind = PostResultKind.PermanentFailure,
                StatusCode = status,
                Response = response
            };
        }

        public static PostResult Transient(int status, string response)
        {
            return new PostResult {
                Kind = PostResultKind.TransientFailure,
                StatusCode = status,
                Response = response
            };
        }
    }
}
