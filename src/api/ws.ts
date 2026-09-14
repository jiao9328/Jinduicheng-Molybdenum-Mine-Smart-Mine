/**
 * WebSocket 实时数据通道。
 *
 * 大屏上的告警推送、人员定位、设备状态都属于「服务端主动下发」，
 * 用轮询会有延迟而且浪费带宽，统一走这一层。
 *
 * 特性：
 * - 单连接多订阅：一个 socket 按 topic 分发，避免每类数据各开一条连接
 * - 断线自动重连：指数退避，最多退到 30 秒，避免服务端重启时被高频重试打垮
 * - 页面隐藏时暂停重连：大屏长时间无人看管时不必反复尝试
 * - 未连接时静默丢弃：实时数据丢了不影响主流程，各页面的兜底是接口/mock 数据
 *
 * **默认关闭**：只有配置了 `VITE_WS_URL` 才会真的建立连接，原因见下面 `WS_URL` 的注释。
 * 关闭时订阅照常登记，页面改用轮询兜底（见 `views/EquipmentView.vue`）。
 */

/**
 * 消息处理函数。
 *
 * 载荷来自 `JSON.parse`，通道不可能知道它的结构，所以这里是 `unknown`——
 * 这不是偷懒，是事实：类型由「哪个主题推什么」决定，而那是业务知识。
 * 需要具体类型时用 `subscribe<T>()` 声明，见下面的泛型说明。
 */
export type MessageHandler = (payload: unknown) => void

interface Subscription {
  handler: MessageHandler
  /** 是否只收一次 */
  once: boolean
}

/**
 * 连接地址。**未显式配置时实时通道整体关闭**，不发起任何连接。
 *
 * 为什么不让它默认连同源 `/ws`：实时后端尚未就绪，而 WebSocket 握手失败时
 * 浏览器会自己往控制台写一条 error，JS 侧拦不住（这和可以被 catch 的 fetch 不同）。
 * 再加上断线退避重连，一条挂着的屏会**周期性地一直报错**，
 * 直接打破项目「0 控制台错误」的验收线。
 * 「不尝试」是唯一能既保留功能又不污染的方案。
 *
 * 这与 `VITE_USE_ONLINE_3D` 是同一套取舍：依赖外部服务的开关默认关，
 * 由部署方按现场条件打开。后端就绪后配上 `VITE_WS_URL` 即可，业务代码不用动。
 */
const WS_URL: string | undefined = import.meta.env.VITE_WS_URL as string | undefined

/** 实时通道是否启用 */
export const realtimeEnabled = Boolean(WS_URL)

/** 重连退避的上下限 */
const RECONNECT_MIN = 1000
const RECONNECT_MAX = 30000

class RealtimeChannel {
  private socket: WebSocket | null = null
  private subscriptions = new Map<string, Set<Subscription>>()
  private reconnectDelay = RECONNECT_MIN
  private reconnectTimer: number | undefined
  /** 主动关闭时不再重连 */
  private closedByUser = false
  /** 是否已连上过，用于区分首次连接与重连 */
  private everConnected = false
  /** 「通道未启用」只提示一次 */
  private disabledLogged = false

  /** 建立连接。重复调用是安全的。 */
  connect() {
    if (!realtimeEnabled) {
      // 只提示一次，别每次订阅都刷屏
      if (!this.disabledLogged) {
        this.disabledLogged = true
        console.info('[ws] 未配置 VITE_WS_URL，实时通道已关闭；页面改用轮询兜底')
      }
      return
    }

    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return
    this.closedByUser = false

    try {
      this.socket = new WebSocket(WS_URL as string)
    } catch (err) {
      // 地址非法等同步异常，走退避重试而不是直接崩掉
      console.warn('[ws] 连接创建失败：', err)
      this.scheduleReconnect()
      return
    }

    this.socket.onopen = () => {
      this.reconnectDelay = RECONNECT_MIN

      if (this.everConnected) {
        console.info('[ws] 已重连')
      }
      this.everConnected = true

      // 重连后重新声明订阅，服务端才知道前端关心哪些主题
      for (const topic of this.subscriptions.keys()) {
        this.send({ type: 'subscribe', topic })
      }
    }

    this.socket.onmessage = (event) => this.dispatch(event.data)

    this.socket.onclose = () => {
      this.socket = null
      if (!this.closedByUser) this.scheduleReconnect()
    }

    this.socket.onerror = () => {
      // 错误之后一定会有 close，重连逻辑统一放在 onclose，这里只记录
      // 首次连不上是常态（后端未就绪），不刷 error 级别日志
      if (this.everConnected) console.warn('[ws] 连接异常')
    }
  }

  /**
   * 订阅某个主题，返回取消订阅的函数。
   *
   * 开头必须兜底调一次 `connect()`。原实现只往「已建立的连接」上发订阅消息，
   * 而 `connect()` 仅由模块级的 visibilitychange 监听触发，
   * 于是「订阅之后一直没切过前台」这条路径永远不会建连——
   * 订阅登记在册，socket 却是 null，一条消息都收不到，而且不报错。
   * `connect()` 自身幂等（已连接/连接中直接返回），无条件调用没有副作用。
   *
   * 泛型 `T` 是这个主题的载荷类型，由调用方按业务声明（如 `subscribe<DeviceAlert>`）。
   * 通道内部统一按 `unknown` 存——这是全项目唯一一处
   * 「线缆上的数据」到「业务类型」的断言点，集中在这里好过散在每个调用处。
   */
  subscribe<T = unknown>(topic: string, handler: (payload: T) => void, once = false): () => void {
    this.connect()

    if (!this.subscriptions.has(topic)) {
      this.subscriptions.set(topic, new Set())
      // 刚 connect 完时 socket 还在 CONNECTING，这一句会被 send() 丢弃，
      // 真正的订阅声明由 onopen 遍历 subscriptions 补发——所以顺序不能调换：
      // 必须在 set(topic) 之后再等 onopen，否则补发时这个主题还不在表里。
      // 连着的时候订阅新主题，才靠这一句即时生效。
      this.send({ type: 'subscribe', topic })
    }
    const sub: Subscription = { handler: handler as MessageHandler, once }
    this.subscriptions.get(topic)!.add(sub)

    return () => this.unsubscribe(topic, sub)
  }

  private unsubscribe(topic: string, sub: Subscription) {
    const set = this.subscriptions.get(topic)
    if (!set) return

    set.delete(sub)
    if (set.size === 0) {
      this.subscriptions.delete(topic)
      this.send({ type: 'unsubscribe', topic })
    }
  }

  private dispatch(raw: string) {
    let msg: { topic?: string; data?: unknown }
    try {
      msg = JSON.parse(raw)
    } catch {
      console.warn('[ws] 收到非 JSON 消息，已忽略')
      return
    }

    if (!msg.topic) return

    const set = this.subscriptions.get(msg.topic)
    if (!set) return

    for (const sub of [...set]) {
      try {
        sub.handler(msg.data)
      } catch (err) {
        console.error(`[ws] 主题 ${msg.topic} 的处理函数抛错：`, err)
      }
      if (sub.once) this.unsubscribe(msg.topic, sub)
    }
  }

  private send(payload: Record<string, unknown>) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload))
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return
    // 页面在后台时不重连，等用户切回来再说
    if (document.hidden) return

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX)
      this.connect()
    }, this.reconnectDelay)
  }

  /** 主动断开，不再重连 */
  close() {
    this.closedByUser = true
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.socket?.close()
    this.socket = null
  }

  /** 当前是否已连接 */
  get connected() {
    return this.socket?.readyState === WebSocket.OPEN
  }
}

export const realtime = new RealtimeChannel()

/** 页面切回前台时补一次重连 */
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) realtime.connect()
})

/**
 * 业务主题常量，避免各处手写字符串写错。
 *
 * 只有设备运行状态这一个主题有消费方（设备管理页的告警提醒面板）。
 * 原先还挂着 alarm / personnel / output 三个主题，但全库没有任何页面订阅它们，
 * 属死常量，已删除——留着会让人以为「实时告警/人员定位/产量上报」是通的，
 * 实际上一个推送都没接。
 */
export const TOPICS = {
  /** 设备运行状态 */
  deviceStatus: 'device.status'
} as const
