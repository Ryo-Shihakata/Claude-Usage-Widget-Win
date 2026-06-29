import type { WidgetApi } from './index'

declare global {
  interface Window {
    widget: WidgetApi
  }
}

export {}
