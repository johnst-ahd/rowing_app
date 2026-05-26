import type { Plugin } from 'vite';

/** Strip crossorigin from script/link tags — breaks Capacitor Android WebView module load. */
export function capacitorNativeHtml(): Plugin {
  return {
    name: 'capacitor-native-html',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(/\s+crossorigin(?:="[^"]*")?/g, '');
    },
  };
}
