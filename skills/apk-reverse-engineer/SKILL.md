---
name: apk-reverse-engineer
description: APK reverse engineering skill for Android application analysis. Use when decompiling APKs, mapping API surfaces, tracing authentication flows, extracting protocols via Frida (non-MITM), or analyzing obfuscated Android code with jadx/smali/Frida/Ghidra. Trigger on any request involving APK analysis, Android app reversing, protocol extraction from mobile apps, building unofficial API clients, or understanding how an Android app communicates with its backend. Also use when the user mentions jadx, smali, Frida, Ghidra, certificate pinning, or Retrofit annotation mapping in context of app analysis.
---

# APK Reverse Engineering

A generic workflow for reverse engineering Android APKs — from decompilation through protocol extraction to implementation. Based on real-world learnings from intercepting and implementing unofficial protocol clients.

## Toolchain

| Tool | Purpose | Install |
|------|---------|---------|
| **jadx** | Java/Kotlin decompiler — APK → readable Java source | `jadx base.apk -d ./decompiled` |
| **smali** | Bytecode disassembly — fallback when jadx fails on complex methods | Ships with jadx |
| **Frida** | Runtime instrumentation — intercept crypto, hook TLS, dump data in-memory, bypass pinning without MITM proxy | `pip install frida-tools` |
| **Ghidra** | Binary analysis — native `.so` libraries, heavily obfuscated Java/Kotlin, complex state machines | Requires JRE 21+ |
| **apktool** | Resource extraction — decode manifest, layouts, resources | `apt install apktool` or manual |

### Non-MITM Philosophy (Frida over Proxy)

Prefer Frida-based traffic capture over HTTP(S) proxy tools (mitmproxy/Burp/Charles):

- **Frida hooks at the app level** — captures data before TLS encryption and after decryption. No certificate trust issues on Android 7+ (no root needed for user-installed CA promotion).
- **Bypasses certificate pinning** without modifying the APK or installing custom CAs.
- **Can intercept at any layer** — OkHttp interceptor, Retrofit calls, raw socket writes, native SSL functions.
- **Captures both HTTP and non-HTTP protocols** (WebSocket, gRPC, custom TCP).

Reserve proxy tools for cases where you need external replay capability or want to inspect traffic from multiple devices.

### Ghidra MCP Integration

For complex analysis (native code, heavy obfuscation, custom packers), the Ghidra MCP can be configured as an MCP server. This allows querying Ghidra's analysis programmatically. Configure in `~/.pi/agent/mcp.json`:

```json
{
  "mcpServers": {
    "ghidra": {
      "command": "python3",
      "args": ["/path/to/ghidra-mcp-server/ghidra_mcp.py"]
    }
  }
}
```

This is optional — only needed for the hardest cases (native protocol implementations, custom encryption, heavily obfuscated Kotlin flows).

---

## Workflow

Follow these phases in order. Each phase builds on the previous one.

### Phase 1: Decompile

```bash
jadx base.apk -d ./decompiled
```

Output structure:
- `defpackage/` — obfuscated classes (short names like `bx1`, `tr2`, `g49`)
- `com/...` — preserved package names (model classes, sometimes API interfaces)
- `resources/` — Android resources (layouts, strings, network config)

**Verify**: You should see tens of thousands of Java files. If you only get a handful, the APK may be packed or protected — proceed to Phase 8 (Ghidra).

### Phase 2: Assess Certificate Pinning (before any traffic capture)

Check pinning to determine what Frida hooks you'll need:

1. **`res/xml/network_security_config.xml`** — Android-level pinning config. If present without any config or with `debug-overrides` only, standard Frida hooking works.
2. **`CertificatePinner`** — search for this class. Check if it's configured (empty builder = no pinning).
3. **Search for `sha256/`** — may appear in error messages vs actual pin configuration. Distinguish between the two.
4. **Check `X509TrustManager`** custom implementations — custom trust managers often indicate pinning or custom TLS handling.

**Frida pinning bypass template** (when needed):

```javascript
// frida-pinning-bypass.js
Java.perform(function() {
    // Bypass common OkHttp CertificatePinner
    var CertificatePinner = Java.use('okhttp3.CertificatePinner');
    CertificatePinner.check.overload('java.lang.String', 'java.util.List').implementation = function() {
        return;
    };
    // Bypass TrustManager checks
    var TrustManager = Java.use('javax.net.ssl.X509TrustManager');
    TrustManager.checkServerTrusted.overload('[Ljava.security.cert.X509Certificate;', 'java.lang.String').implementation = function() {
        return;
    };
});
```

**Verify**: Attempt a Frida session. If the app connects, proceed. If the app detects Frida, add anti-detection bypasses (see Phase 8).

### Phase 3: Map Framework Annotations (Your Rosetta Stone)

Retrofit is the most common HTTP client. Its annotations (`@POST`, `@GET`, `@Body`, `@Path`) get obfuscated by ProGuard/R8.

Approach:
1. Search for `defpackage/` files that contain Retrofit-like annotations. Look for classes that:
   - Implement `java.lang.annotation.Annotation`
   - Have runtime retention (`@Retention(RetentionPolicy.RUNTIME)`)
   - Have few fields or methods (annotations are simple)
2. For each suspect annotation class, check:
   - Number of parameters (e.g., a `@POST("/path")` has one string parameter)
   - The import in files that use it (guides you to the annotation's package)
3. Common annotation patterns:
   - 1 string param = `@GET` or `@POST` (distinguish by usage context)
   - 1 object param = `@Body`
   - 1 string param with specific name = `@Path`, `@Query`
   - No params = `@Headers`, `@FormUrlEncoded`
4. Verify by cross-referencing: find a Retrofit interface, check what annotations it uses on its methods.

**Output**: A mapping file `annotations.md` like:
```markdown
- @aoe → POST
- @ke8 → GET
- @io3 → Body
- @pe2 → Path
- @qw7 → Query
- @mn4 → Header
```

**Verify**: You can read any Retrofit interface file and identify endpoint methods, their HTTP methods, paths, and parameter types.

### Phase 4: Find the Service URL Registry

Apps typically have a single configuration class with base URLs across environments (prod, test, dev).

Search strategies:
1. **Grep for `https://` or `http://`** across the decompiled code
2. **Look for environment strings** — `"Production"`, `"Staging"`, `"Development"`, `"Sandbox"`, `"Test"`
3. **Search for URL segments** — `/api/`, `/v1/`, `/oauth/`, `/sso/`
4. **Check non-obfuscated config classes** — some apps keep network config in readable packages

The URL config file shows your full attack surface — every backend service, auth provider, and media storage endpoint.

**Output**: A URL map `urls.md`:
```markdown
- Hermes API: https://hermes.garmin.com/
- SSO: https://sso.garmin.com/
- Media: https://media.garmin.com/
```

**Verify**: Every base URL in `urls.md` has a corresponding usage in a Retrofit interface or HTTP client setup class.

### Phase 5: Read the API Surface (Retrofit Interfaces)

Once annotations are mapped, the Retrofit interface file(s) are your API catalog. Each method is one endpoint:

```
interface SomeApi {
    @POST("/v1/register")
    fun register(@Body request: RegistrationRequest): Response<RegistrationResponse>

    @GET("/v1/status/{id}")
    fun getStatus(@Path("id") id: String): Response<StatusResponse>
}
```

1. Find all Retrofit interfaces — search for files that import your mapped `@POST`/`@GET` annotations
2. For each interface, document:
   - HTTP method and path (resolve path parameters)
   - Request body type (find the model class)
   - Response type
   - Headers (fixed or dynamic)
3. Cross-reference with the URL config — you now have complete endpoint URLs

**Output**: An API catalog `api.md`:
```markdown
## Hermes API
### POST /v1/register
- Body: RegistrationRequest (model class)
- Response: RegistrationResponse
- Headers: Content-Type: application/json, RegistrationApiKey: <token>
```

**Verify**: Every endpoint in `api.md` is backed by a Retrofit interface method in the decompiled code.

### Phase 6: Trace Auth Flows (Backwards from API)

Authentication is the trickiest part. Work backwards:

1. **Pick an authenticated endpoint** — the registration or login endpoint from Phase 5
2. **Trace token/header construction**: find where the request headers are set (e.g., `@Header("Authorization")` → trace the parameter back)
3. **Follow the chain**:
   - Find the Retrofit interface's call sites
   - Check what object constructs the service
   - Look for interceptor classes (OkHttp Interceptor is popular for auth headers)
   - Trace where the interceptor gets its token
4. **Identify auth paths** — apps often have multiple:
   - Direct login (username/password → token)
   - OAuth2 (webview/SSO → authorization code → token)
   - AccountManager (Android system accounts → token)
5. **For each auth path**, map the complete call chain from user input to API call

**Common patterns to recognize**:
- OkHttp `Interceptor` in the network client setup = automatic auth header injection
- `AccountManager.getAuthToken()` = Android system account integration
- `WebView` with `WebViewClient.shouldOverrideUrlLoading()` = SSO/OAuth flow
- Custom `Authenticator` implementation = automatic token refresh

**Output**: Auth flow diagrams with class/function names for each path.

**Verify**: You can identify every header/token in the API's request and trace where it comes from without runtime instrumentation. Then validate with Frida hooks to confirm.

### Phase 7: Frida-Based Traffic Capture (Non-MITM)

Use Frida to intercept live traffic at the app level, avoiding certificate trust issues entirely.

#### 7a: Basic Frida Setup

```bash
# List running processes
frida-ps -U

# Attach to app
frida -U com.example.app -l capture.js

# Spawn app and attach
frida -U -f com.example.app -l capture.js --no-pause
```

#### 7b: Intercept OkHttp Requests/Responses

```javascript
// frida-okhttp-capture.js
Java.perform(function() {
    // Hook OkHttp Client's newCall to intercept all HTTP traffic
    var OkHttpClient = Java.use('okhttp3.OkHttpClient');
    OkHttpClient.newCall.implementation = function(request) {
        console.log('[HTTP] ' + request.method() + ' ' + request.url());
        // Log headers
        var headers = request.headers();
        for (var i = 0; i < headers.size(); i++) {
            console.log('  Header: ' + headers.name(i) + ': ' + headers.value(i));
        }
        // Store for response capture
        var call = this.newCall(request);
        var Call = Java.use('okhttp3.Call');
        // Can also hook enqueue/execute for response bodies
        return call;
    };

    // Hook Response body for content
    var Response = Java.use('okhttp3.Response');
    Response.body.implementation = function() {
        var body = this.body();
        if (body) {
            var source = body.source();
            try {
                var content = source.readUtf8();
                console.log('[RESPONSE BODY] ' + content);
            } catch(e) {
                console.log('[RESPONSE] (binary or empty)');
            }
        }
        return body;
    };
});
```

#### 7c: Hook Specific Retrofit Methods

```javascript
// frida-retrofit-hook.js
Java.perform(function() {
    // Find the Retrofit interface class (replace with actual obfuscated name)
    var RetrofitInterface = Java.use('defpackage.fb9');
    var impl = RetrofitInterface.$impl;  // Retrofit generates implementation classes

    // Hook specific endpoint methods
    RetrofitInterface.register.implementation = function(request) {
        console.log('[API] register() called');
        console.log('[API] Request body: ' + JSON.stringify(request));
        var result = this.register(request);
        console.log('[API] Response: ' + JSON.stringify(result));
        return result;
    };
});
```

#### 7d: Dump Strings, Tokens, Crypto Material

```javascript
// frida-key-capture.js
Java.perform(function() {
    // Hook all strings passed to StringBuilder (catches token construction)
    var StringBuilder = Java.use('java.lang.StringBuilder');
    StringBuilder.append.overload('java.lang.String').implementation = function(str) {
        if (str && (str.indexOf('token') >= 0 || str.indexOf('auth') >= 0 ||
                    str.indexOf('bearer') >= 0 || str.indexOf('key') >= 0)) {
            console.log('[STR] ' + str);
        }
        return this.append(str);
    };

    // Hook crypto operations
    var Cipher = Java.use('javax.crypto.Cipher');
    Cipher.doFinal.overload('[B').implementation = function(input) {
        console.log('[CRYPTO] doFinal input: ' + bytesToHex(input));
        var result = this.doFinal(input);
        console.log('[CRYPTO] doFinal output: ' + bytesToHex(result));
        return result;
    };
});

function bytesToHex(bytes) {
    var hex = [];
    for (var i = 0; i < bytes.length; i++) {
        hex.push(('0' + (bytes[i] & 0xFF).toString(16)).slice(-2));
    }
    return hex.join('');
}
```

#### 7e: Intercept Native TLS/SSL Traffic

When the app uses native (NDK) TLS — hook at the JNI bridge or native layer:

```bash
# Trace native SSL functions
frida-trace -U com.example.app -i "SSL_write" -i "SSL_read"
```

#### Verify Frida Setup

Run against the app and trigger a network action. You should see:
- HTTP method + URL logged for each request
- Headers and body content
- Response data

If Frida doesn't connect (app detects instrumentation), see Phase 8.

### Phase 8: Ghidra for Complex Obfuscation

Use Ghidra when:
- **jadx fails** on many methods (packed or heavily obfuscated)
- **Native libraries** (`.so` files) implement core protocol logic
- **Custom encryption/encoding** is implemented in native code
- **Kotlin coroutine state machines** are unreadable in jadx — smali bytecode is easier
- **Frida detection** needs to be bypassed (find anti-hooking checks)

#### 8a: Analyze Native Libraries

```bash
# Extract native libs from APK
unzip base.apk "lib/**/*.so" -d ./native-libs

# For Ghidra: import each .so for each architecture
# Start with x86_64 (emulator) or arm64-v8a (device)
ghidraRun  # then Import -> select .so -> analyze
```

In Ghidra, look for:
- JNI function names (Java_com_example_...)
- Hardcoded strings (encryption keys, protocol constants)
- Custom protocol serialization/deserialization logic
- Certificate pinning or trust store validation in native code

#### 8b: Handle Smali Fallback

When jadx shows `// decompiled with errors` or empty method bodies:

1. Find the corresponding `.smali` file in the APK's smali directory:
   ```bash
   apktool d base.apk -o ./apk-decompiled
   # Smali files in ./apk-decompiled/smali/...
   ```
2. Search for the method signature to locate the smali code
3. Read smali bytecode directly:
   - `.method` blocks define methods
   - `const-string v0, "Production"` — hardcoded strings
   - `invoke-virtual` / `invoke-static` — method calls
   - `move-result` / `move-result-object` — capture return values
4. Cross-reference register usage to trace data flow

#### 8c: Bypass Frida Detection

Search decompiled code for:
- Checking `/proc/self/maps` for `frida` or `frida-agent`
- Checking for typical Frida ports (27041-27042)
- Checking for named pipes or D-Bus
- Checking `android.os.Build.TAGS` for "test-keys"

Use a Frida script that hooks detection methods and returns false/expected values:

```javascript
// frida-anti-detect.js
Java.perform(function() {
    // Generic: iterate all loaded classes and hook common detection methods
    Java.enumerateLoadedClasses({
        onMatch: function(className) {
            if (className.indexOf('detect') >= 0 ||
                className.indexOf('Detect') >= 0 ||
                className.indexOf('anti') >= 0) {
                console.log('[DETECTION] ' + className);
            }
        },
        onComplete: function() {}
    });
});
```

### Phase 9: Detect Custom Serialization

When a type has a custom `KSerializer` (Kotlin Serialization) or `Converter.Factory` (Retrofit/Gson/Moshi), the JSON wire format may differ from the Java field types.

1. **Search for `KSerializer` implementations** — classes that implement `kotlinx.serialization.KSerializer`
2. **Search for `Converter.Factory` implementations** — classes that implement `retrofit2.Converter$Factory`
3. **For each custom serializer**, check:
   - What type it handles
   - What transformation it applies
   - Whether field types match wire types (e.g., `Long` stored as zero-padded string, `Date` formatted differently)
4. **Check for custom adapters**: `@JsonAdapter`, `TypeAdapterFactory` (Gson), `@JsonSerialize` (Jackson)

Common traps:
- Long integers serialized as zero-padded strings (e.g., IMEI: `123456789012345` as `"00000123456789012345"`)
- Dates in non-ISO formats
- Enums serialized as integers instead of strings
- UUIDs serialized as concatenated hex without dashes

**Output**: A serialization notes file `serialization.md`.

**Verify**: Compare the Java field type with the JSON wire format captured via Frida (Phase 7). They should match.

### Phase 10: Incremental Implementation

Build in this order, validating each step against Frida captures:

1. **Auth** — implement login/SSO flow first. Validate by comparing tokens
2. **Read-only endpoints** — implement GET requests. Validate response structure
3. **Write endpoints** — implement POST/PUT/DELETE. Validate with before/after state
4. **Edge cases** — pagination, error handling, rate limiting, reconnection

---

## Mapping File Convention

Maintain a living mapping document as you work:

```markdown
# Protocol Map — <App Name>

## Deobfuscation Map
| Obfuscated | Real Name | Source |
|------------|-----------|--------|
| `fb9` | HermesApi | Retrofit interface |
| `yvj` | ServiceConfig | URL registry |
| `aoe` | POST | Retrofit annotation |
| `ke8` | GET | Retrofit annotation |

## Enums / Constants
| Value | Purpose | Location |
|-------|---------|----------|
| `"Production"` | Environment selector | `g49.b()` |
| `"garmin.com"` | Base domain | `yvj.java` |

## Auth Paths
| Path | Entry Point | Token Source | Status |
|------|-------------|-------------|--------|
| AccountManager | `AccountManager.getAuthToken()` | Garmin Connect installed | ❌ No device |
| WebView SSO | `WebViewClient.shouldOverrideUrlLoading()` | In-app browser | ✅ Implemented |

## API Endpoints
...

## Field Mapping (Java → Wire)
| Java Field | Wire Format | Serializer |
|------------|-------------|------------|
| `imei: Long` | `"00000123456789012345"` (string, 20 chars) | Custom KSerializer |
| `timestamp: Long` | `"2024-01-15T10:30:00Z"` | Custom DateAdapter |
```

Update this file as you discover new mappings. It becomes your single source of truth and saves you from re-tracing the same chains.

---

## Troubleshooting

### jadx fails to decompile
→ Read the `.smali` file directly (use `apktool d` first). Focus on `const-string`, `invoke-virtual`, and `move-result` instructions.

### Frida can't attach
→ App detects Frida. Use Phases 8b/c to find and bypass detection. Try `frida -U -f com.example.app --no-pause` (spawn vs attach). Check for root detection.

### Can't find Retrofit interfaces
→ Not every app uses Retrofit. Check for other HTTP clients: OkHttp directly, Ktor (Kotlin), Volley, custom `HttpURLConnection` wrappers, or native (NDK) HTTP. Adjust annotation mapping accordingly.

### No clear URL config
→ Some apps hardcode URLs per-endpoint or embed them in resources. Search `strings.xml` for URL fragments. If completely dynamic (server-driven), focus on Frida traffic capture to discover endpoints as they're used.

### Custom protocol (not HTTP)
→ Skip Retrofit analysis. Focus on Phase 7 (Frida) to intercept at the socket level or hook protocol-specific serialization methods. Use Ghidra for native protocol implementations.

### App uses Kotlin serialization heavily
→ Search for `@Serializable` annotations (may be obfuscated). Kotlin serialization may use `serializer()` functions rather than annotations. Look for `KSerializer` instances in companion objects.

### Can't trace auth flow in decompiled code
→ Use Frida to dump the actual auth flow at runtime. Hook the network client's request interceptor and log all calls with stack traces to see the full call path:
```javascript
Java.perform(function() {
    var Thread = Java.use('java.lang.Thread');
    Interceptor.intercept.implementation = function(chain) {
        console.log(Java.use('android.util.Log').getStackTraceString(
            Java.use('java.lang.Exception').$new()));
        return this.intercept(chain);
    };
});
```
