// Opt-in for the disposable local launcher only; Vite replaces DEV with false in builds.
export const wjaxLocalPreviewEnabled = import.meta.env.DEV
  && import.meta.env.VITE_WJAX_KIND_PREVIEW === 'true'
  && ['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname)
