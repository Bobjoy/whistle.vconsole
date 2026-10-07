/**
 * Parse a compact human-readable device label from a User-Agent string,
 * e.g. "iPhone · iOS 16.0 · WeChat 8.0.28" or "Pixel 7 · Android 13 · Chrome 120".
 * Used by list_sessions so agents can tell devices apart without guessing.
 */

import type { RealDeviceHints } from './protocol.js';

/** real model/os/touch hints from the probe (see HelloMsg.realDevice) */
export type { RealDeviceHints };

/**
 * Bridge for probes from the previous generation: they auto-filled
 * deviceName with "<model> · Android <ver>" — parse it back so labels get
 * fixed on reconnect without waiting for those pages to reload.
 */
export function realDeviceFromDeviceName(name?: string): RealDeviceHints | undefined {
  if (!name) { return undefined; }
  const m = name.match(/^(.{1,40}?) · Android (\d+(?:\.\d+)*)$/);
  return m ? { model: m[1], osVersion: m[2] } : undefined;
}

/**
 * Tokens of the first UA comment, e.g.
 * "Linux; Android 12; HarmonyOS; DBR-W00; HMSCore 6.16.4.352" → 5 tokens.
 * Tokenizing beats the old "Android <ver>; <model>)" regex, which cannot cross
 * the extra `HarmonyOS;` Huawei inserts between the version and the model.
 */
function platformTokens(ua: string): string[] {
  const comment = ua.match(/\(([^)]*)\)/);
  return comment ? comment[1].split(';').map((t) => t.trim()).filter(Boolean) : [];
}

const PLATFORM_NOISE =
  /^(?:Linux|U|wv|WebView|Mobile|Phone|Tablet|Android\s[\d.]+|HarmonyOS|OpenHarmony[\d.\s]*|HMSCore\s[\d.]+|KMSCore\s[\d.]+|GMSCore\s[\d.]+|CPU.*|Version.*|[a-z]{2}(?:-[A-Za-z]{2})?|[\d._]+)$/i;

function androidModelFrom(tokens: string[]): string | undefined {
  for (const t of tokens) {
    const model = t.split(/\s+Build\//)[0].trim();
    if (model && !PLATFORM_NOISE.test(model)) { return model; }
  }
  return undefined;
}

export function parseDeviceLabel(ua: string, real?: RealDeviceHints): string {
  if (!ua) { return 'unknown'; }
  const parts: string[] = [];

  // --- device / OS ---------------------------------------------------------
  // deviceOs is set once the chain identifies hardware/OS; the trailing "Mobile"
  // fallback is only for UAs whose device stayed unknown
  let deviceOs = false;
  const platform = platformTokens(ua);
  const androidTok = platform.find((t) => /^Android\s[\d.]+/i.test(t));
  const harmonyTok = platform.find((t) => /^(?:HarmonyOS|OpenHarmony)/i.test(t));
  const iosVersion = ua.match(/OS (\d+[_\d]*) like Mac OS X/);
  if (/iPhone/.test(ua)) {
    deviceOs = true;
    parts.push('iPhone');
    if (iosVersion) { parts.push('iOS ' + iosVersion[1].replace(/_/g, '.')); }
  } else if (/iPad/.test(ua)) {
    deviceOs = true;
    parts.push('iPad');
    if (iosVersion) { parts.push('iPadOS ' + iosVersion[1].replace(/_/g, '.')); }
  } else if (androidTok || harmonyTok) {
    deviceOs = true;
    // prefer client-hints values: the UA freezes the model to "K" and the
    // version to 10 on Android Chromium
    const model = real?.model || androidModelFrom(platform);
    if (model) { parts.push(model); }
    if (harmonyTok) {
      // HarmonyOS reports an Android version for its compat layer; naming that
      // instead of HarmonyOS hides that the device is a Huawei
      const hv = harmonyTok.match(/[\d.]+/);
      parts.push('HarmonyOS' + (hv ? ' ' + hv[0] : ''));
    } else {
      const v = real?.osVersion ? real.osVersion.split('.')[0] : androidTok!.match(/[\d.]+/)![0];
      parts.push('Android ' + v);
    }
  } else if (/Macintosh|Mac OS X/.test(ua)) {
    deviceOs = true;
    const mac = ua.match(/Mac OS X (\d+[_.\d]*)/);
    // an iPad that asked for the desktop site ships this exact UA, and the frozen
    // "10_15_7" in it says nothing about iPadOS. A real Mac has no touch points,
    // so the probe's isTablet hint is the only way to tell them apart; probes that
    // don't report it keep the old Mac label.
    if (real?.isTablet) {
      parts.push('iPad');
    } else {
      parts.push('Mac' + (mac ? ' OS X ' + mac[1].replace(/_/g, '.') : ''));
    }
  } else if (/Windows/.test(ua)) {
    deviceOs = true;
    const win = ua.match(/Windows NT (\d+\.\d+)/);
    const map: Record<string, string> = { '10.0': '10+', '6.3': '8.1', '6.2': '8' };
    parts.push('Windows' + (win ? ' ' + (map[win[1]] || win[1]) : ''));
  }

  // --- browser + container class -------------------------------------------
  // label layout (user spec): 设备 · 系统 · 浏览器 版本（容器身份）
  // PC/Browser 不写进括号：系统段（Windows/Mac/iPhone/Android…）已经说明了这些，
  // 括号只留系统看不出来的东西——App/微信外壳、以及 Chrome 内核套壳的产品名
  const mobile = /Android|iPhone|iPad|Mobile|HarmonyOS/i.test(ua);
  const hasBrowserSig =
    /Safari|Chrome|Edg(?:e|A|iOS)?|Firefox|SamsungBrowser|QQBrowser|UCBrowser|MiuiBrowser|HeyTapBrowser|VivoBrowser|HuaweiBrowser|OppoBrowser|Quark|baidubrowser|MSIE|Trident/i.test(ua);
  // "; wv)" = Android WebView flag — an embedded app webview, never a
  // standalone browser, even when the UA carries a full Chrome signature
  const isWebview = /;\s*wv\)/.test(ua);
  const container = /MicroMessenger|wxwork/i.test(ua) ? 'WeChat'
    : /Electron/i.test(ua) ? 'App'
    : isWebview ? 'App'
    : !mobile ? 'PC'
    : hasBrowserSig ? 'Browser'
    : 'App';
  // WeChat/App carry their container identity + version when the UA exposes
  // one: MicroMessenger/8.0.49, Electron/41.0.3, or the trailing
  // "(appId; version)" group many app shells append (e.g. "(stock; 2.4.5)")
  let containerLabel = container;
  if (container === 'WeChat') {
    const v = ua.match(/MicroMessenger\/(\d+(?:\.\d+)?)/);
    // "App" prefix keeps WeChat in the same visual family as the other
    // app-shell containers (App stock 2.4.5 / App ZCode 3.14.4)
    containerLabel = 'App WeChat' + (v ? ' ' + v[1] : '');
  } else if (container === 'App') {
    // identity sources, in order of trust:
    //  1. Electron apps: their own "Name/version" UA token that is not an
    //     engine marker — e.g. ZCode/3.14.4 in ZCode's Electron UA
    //  2. webview shells: version from the trailing "(x; 2.4.5)" group, name
    //     from the app's "scheme/hazq" token (falling back to the x)
    //  3. Electron runtime version
    const ev = ua.match(/Electron\/(\d+(?:\.\d+)?)/);
    const tail = (() => {
      const re = /\(([A-Za-z][\w-]*);\s*(\d[\w.]*)\)/g;
      let m: RegExpExecArray | null = null;
      let last: RegExpExecArray | null = null;
      while ((m = re.exec(ua)) !== null) { last = m; }
      return last;
    })();
    const known = /^(?:Mozilla|AppleWebKit|Chrome|Safari|Version|Electron|Edg|EdgA|EdgiOS|Firefox|Gecko|Mobile)$/i;
    const tre = /(?:^|[\s(])([A-Za-z][\w.-]*)\/(\d+(?:\.\d+)*)(?=[\s)]|$)/g;
    let tm: RegExpExecArray | null = null;
    let appTok: RegExpExecArray | null = null;
    // first "Name/version" token that is not an engine/browser marker
    while ((tm = tre.exec(ua)) !== null) {
      if (!known.test(tm[1])) { appTok = tm; break; }
    }
    if (ev) {
      containerLabel = appTok ? `App ${appTok[1]} ${appTok[2]}` : 'App ' + ev[1];
    } else if (tail) {
      const scheme = ua.match(/\bscheme\/([\w-]+)/i);
      containerLabel = `App ${scheme ? scheme[1] : tail[1]} ${tail[2]}`;
    } else if (appTok) {
      containerLabel = `App ${appTok[1]} ${appTok[2]}`;
    }
  }

  // main browser segment = the KERNEL the page actually renders with
  // (an Edge UA carries "Chrome/153" as the kernel — that's what matters for
  // web compatibility), major version only
  const chrome = ua.match(/Chrome\/(\d+)/);
  const firefox = !chrome && ua.match(/Firefox\/([\d.]+)/);
  const safari = !chrome && !firefox && ua.match(/Version\/([\d.]+).*Safari/);
  const kernel = chrome ? 'Chrome ' + chrome[1]
    : safari ? 'Safari ' + safari[1]
    : firefox ? 'Firefox ' + firefox[1]
    : '';

  // generic classes stay unlabelled (see the header note); App/WeChat keep theirs
  if (container === 'PC' || container === 'Browser') {
    containerLabel = '';
    // ...unless the UA ships its own product token: the kernel alone would hide
    // that the page runs in Samsung / QQ / UC / Mi / Huawei Browser, each with
    // quirks worth debugging against. No such token = the product IS the kernel.
    const product = ua.match(
      /\b(Edg(?:e|A|iOS)?|SamsungBrowser|MiuiBrowser|MQQBrowser|QQBrowser|UCBrowser|HuaweiBrowser|HeyTapBrowser|VivoBrowser|OppoBrowser|Quark|baidubrowser)\/([\d.]+)/i,
    );
    if (product) {
      // major, plus the minor only when it actually carries a number: MQQBrowser
      // 14.3 and UCBrowser 16.5 ARE the marketing versions, while Edge 154.0.0.0
      // and MiuiBrowser 16.0.521824 are just build padding after a zero minor
      const seg = product[2].split('.');
      const ver = seg.length > 1 && seg[1] !== '0' ? seg[0] + '.' + seg[1] : seg[0];
      containerLabel = (/^edg/i.test(product[1]) ? 'Edge' : product[1]) + ' ' + ver;
    }
  }
  const browserSeg = kernel
    ? (containerLabel ? kernel + '（' + containerLabel + '）' : kernel)
    : containerLabel;
  if (browserSeg) { parts.push(browserSeg); }

  if (!deviceOs && /Mobile/.test(ua)) { parts.push('Mobile'); }

  const label = parts.join(' · ');
  return label || ua.slice(0, 60);
}
