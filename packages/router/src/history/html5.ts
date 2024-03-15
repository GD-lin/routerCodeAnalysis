import {
  RouterHistory,
  NavigationCallback,
  NavigationType,
  NavigationDirection,
  HistoryState,
  ValueContainer,
  normalizeBase,
  createHref,
  HistoryLocation,
} from './common'
import {
  computeScrollPosition,
  _ScrollPositionNormalized,
} from '../scrollBehavior'
import { warn } from '../warning'
import { stripBase } from '../location'
import { assign } from '../utils'

type PopStateListener = (this: Window, ev: PopStateEvent) => any

let createBaseLocation = () => location.protocol + '//' + location.host

interface StateEntry extends HistoryState {
  back: HistoryLocation | null
  current: HistoryLocation
  forward: HistoryLocation | null
  position: number
  replaced: boolean
  scroll: _ScrollPositionNormalized | null | false
}

/**
 * Creates a normalized history location from a window.location object
 * @param base - The base path
 * @param location - The window.location object
 */
function createCurrentLocation(
  base: string,
  location: Location
): HistoryLocation {
  const { pathname, search, hash } = location
  // allows hash bases like #, /#, #/, #!, #!/, /#!/, or even /folder#end
  const hashPos = base.indexOf('#')
  if (hashPos > -1) {
    let slicePos = hash.includes(base.slice(hashPos))
      ? base.slice(hashPos).length
      : 1
    let pathFromHash = hash.slice(slicePos)
    // prepend the starting slash to hash so the url starts with /#
    if (pathFromHash[0] !== '/') pathFromHash = '/' + pathFromHash
    return stripBase(pathFromHash, '')
  }
  const path = stripBase(pathname, base)
  return path + search + hash
}

function useHistoryListeners(
  base: string,
  historyState: ValueContainer<StateEntry>,
  currentLocation: ValueContainer<HistoryLocation>,
  replace: RouterHistory['replace']
) {
  let listeners: NavigationCallback[] = []
  let teardowns: Array<() => void> = []
  // TODO: should it be a stack? a Dict. Check if the popstate listener
  // can trigger twice
  let pauseState: HistoryLocation | null = null

  const popStateHandler: PopStateListener = ({
    state,
  }: {
    state: StateEntry | null
  }) => {
    // 新跳转地址
    const to = createCurrentLocation(base, location)
    // 当前路由地址
    const from: HistoryLocation = currentLocation.value
     // 当前state
    const fromState: StateEntry = historyState.value
      // 计步器

    let delta = 0

    if (state) {
       // 目标路由state不为空时，更新currentLocation和historyState缓存
    currentLocation.value = to
    historyState.value = state

    // 暂停监控时，中断跳转并重置pauseState

      // ignore the popstate and reset the pauseState
      if (pauseState && pauseState === from) {
        pauseState = null
        return
      }
      delta = fromState ? state.position - fromState.position : 0
    } else {
      replace(to)
    }

    // Here we could also revert the navigation by calling history.go(-delta)
    // this listener will have to be adapted to not trigger again and to wait for the url
    // to be updated before triggering the listeners. Some kind of validation function would also
    // need to be passed to the listeners so the navigation can be accepted
    // call all listeners
    // 发布跳转事件，将Location、跳转类型、跳转距离等信息返回给所有注册的订阅者，并执行注册回调
    listeners.forEach(listener => {
      listener(currentLocation.value, from, {
        delta,
        type: NavigationType.pop,
        direction: delta
          ? delta > 0
            ? NavigationDirection.forward
            : NavigationDirection.back
          : NavigationDirection.unknown,
      })
    })
  }

  // 暂停监听
  function pauseListeners() {
    pauseState = currentLocation.value
  }

  // 注册监听逻辑,并且返回停止该监听的方法teardown
  function listen(callback: NavigationCallback) {
    // set up the listener and prepare teardown callbacks
    listeners.push(callback)

    const teardown = () => {
      const index = listeners.indexOf(callback)
      if (index > -1) listeners.splice(index, 1)
    }

    teardowns.push(teardown)
    return teardown
  }

  //关闭页面前会执行这个方法，主要作用是记录下当前页面滚动。
  function beforeUnloadListener() {
    const { history } = window
    if (!history.state) return
    history.replaceState(
      assign({}, history.state, { scroll: computeScrollPosition() }),
      ''
    )
  }

  function destroy() {
    for (const teardown of teardowns) teardown()
    teardowns = []
    window.removeEventListener('popstate', popStateHandler)
    window.removeEventListener('beforeunload', beforeUnloadListener)
  }

  // set up the listeners and prepare teardown callbacks
  window.addEventListener('popstate', popStateHandler)
  // TODO: could we use 'pagehide' or 'visibilitychange' instead?
  // https://developer.chrome.com/blog/page-lifecycle-api/
  window.addEventListener('beforeunload', beforeUnloadListener, {
    passive: true,
  })

  return {
    pauseListeners,
    listen,
    destroy,
  }
}

/**
 * Creates a state object
 */
function buildState(
  back: HistoryLocation | null,
  current: HistoryLocation,
  forward: HistoryLocation | null,
  replaced: boolean = false,
  computeScroll: boolean = false
): StateEntry {
  return {
    back,
    current,
    forward,
    replaced,
    position: window.history.length,
    scroll: computeScroll ? computeScrollPosition() : null,
  }
}
// 使用了H5 History能力。其中history.pushState 和history.replaceState 方法被封装到一个名为locationChange的路径变化处理函数中，而locationChange作为一个公共函数，则被push 和 replace 函数调用，这2个函数，也就是我们熟知的Router push 和 Router replace 方法。
// 另外，vue router history的state对象底层也是用到了history.state，只不过再封装成符合vue router的state罢了。
// 最后，useHistoryStateNavigation方法把push、replace、state、location集成到一个对象中返回，完成了history的初始化。

function useHistoryStateNavigation(base: string) {
  const { history, location } = window

  // private variables
  const currentLocation: ValueContainer<HistoryLocation> = {
    value: createCurrentLocation(base, location),
  }
  const historyState: ValueContainer<StateEntry> = { value: history.state }
  // build current history entry as this is a fresh navigation
  if (!historyState.value) {
    changeLocation(
      currentLocation.value,
      {
        back: null,
        current: currentLocation.value,
        forward: null,
        // the length is off by one, we need to decrease it
        position: history.length - 1,
        replaced: true,
        // don't add a scroll as the user may have an anchor, and we want
        // scrollBehavior to be triggered without a saved position
        scroll: null,
      },
      true
    )
  }

  function changeLocation(
    to: HistoryLocation,
    state: StateEntry,
    replace: boolean
  ): void {
    /**
     * if a base tag is provided, and we are on a normal domain, we have to
     * respect the provided `base` attribute because pushState() will use it and
     * potentially erase anything before the `#` like at
     * https://github.com/vuejs/router/issues/685 where a base of
     * `/folder/#` but a base of `/` would erase the `/folder/` section. If
     * there is no host, the `<base>` tag makes no sense and if there isn't a
     * base tag we can just use everything after the `#`.
     */
    const hashIndex = base.indexOf('#')
    const url =
      hashIndex > -1
        ? (location.host && document.querySelector('base')
            ? base
            : base.slice(hashIndex)) + to
        : createBaseLocation() + base + to
    try {
      // BROWSER QUIRK
      // NOTE: Safari throws a SecurityError when calling this function 100 times in 30 seconds
      history[replace ? 'replaceState' : 'pushState'](state, '', url)
      historyState.value = state
    } catch (err) {
      if (__DEV__) {
        warn('Error with push/replace State', err)
      } else {
        console.error(err)
      }
      // Force the navigation, this also resets the call count
      location[replace ? 'replace' : 'assign'](url)
    }
  }

  function replace(to: HistoryLocation, data?: HistoryState) {
    const state: StateEntry = assign(
      {},
      history.state,
      buildState(
        historyState.value.back,
        // keep back and forward entries but override current position
        to,
        historyState.value.forward,
        true
      ),
      data,
      { position: historyState.value.position }
    )

    changeLocation(to, state, true)
    currentLocation.value = to
  }
  
  function push(to: HistoryLocation, data?: HistoryState) {
    // Add to current entry the information of where we are going
    // as well as saving the current position
    const currentState = assign(
      {},
      // use current history state to gracefully handle a wrong call to
      // history.replaceState
      // https://github.com/vuejs/router/issues/366
      historyState.value,
      history.state as Partial<StateEntry> | null,
      {
        forward: to,
        scroll: computeScrollPosition(),
      }
    )

    if (__DEV__ && !history.state) {
      warn(
        `history.state seems to have been manually replaced without preserving the necessary values. Make sure to preserve existing history state if you are manually calling history.replaceState:\n\n` +
          `history.replaceState(history.state, '', url)\n\n` +
          `You can find more information at https://next.router.vuejs.org/guide/migration/#usage-of-history-state.`
      )
    }
    //第一次是给router history添加forward和scroll的中间跳转，其作用是保存当前页面的滚动位置。

  
    changeLocation(currentState.current, currentState, true)

    const state: StateEntry = assign(
      {},
      buildState(currentLocation.value, to, null),
      { position: currentState.position + 1 },
      data
    )
    
    changeLocation(to, state, false)
    // 为什么要2次跳转才能保存页面位置？ 第一次跳转就是把位置信息记录更新（replaceState）到 未跳转时的router state，以便后面回退时回到原位置
    //大家试想下，当你浏览一个页面，滚动到某个位置，你利用history.pushState跳转到另一个页面时，history堆栈会压入一条记录，但同时vue router会帮助你记录跳转前页面位置，以便在回退时恢复滚动位置。要实现这个效果，就必须在push方法中，在调用changeLocation前把当前页面位置记录到router state中。
    // 要实现这个功能方法有多种，最简单方法就是在跳转前把位置信息记录好放进state里面，然后通过changeLocation(to, state, false)实现跳转。
    // 但官方用了另一种优雅方法解决这个问题，就是在最终跳转前先来一次replace模式的中间跳转，这样在不破坏原页面信息基础上更新了router state，省去更多与页面位置相关的连带处理。这就有了push方法中2次调用changeLocation。

    currentLocation.value = to
  }

  return {
    location: currentLocation,
    state: historyState,

    push,
    replace,
  }
}

/**
 * Creates an HTML5 history. Most common history for single page applications.
 *
 * @param base -
 */
export function createWebHistory(base?: string): RouterHistory {
  
  base = normalizeBase(base)
  //创建vue router 的history对象，包含4个属性：location（当前location）、state（路由页面的history state）、和push、replace2个方法；
  //同时检测history.state是否为空，如果为空，需要压入一个初始化的currentLocation
  const historyNavigation = useHistoryStateNavigation(base)
  // 创建路由监听器
  const historyListeners = useHistoryListeners(
    base,
    historyNavigation.state,
    historyNavigation.location,
    historyNavigation.replace
  )
  function go(delta: number, triggerListeners = true) {
    if (!triggerListeners) historyListeners.pauseListeners()
    history.go(delta)
  }

  const routerHistory: RouterHistory = assign(
    {
      // it's overridden right after
      location: '',
      base,
      go,
      createHref: createHref.bind(null, base),
    },

    historyNavigation,
    historyListeners
  )

  Object.defineProperty(routerHistory, 'location', {
    enumerable: true,
    get: () => historyNavigation.location.value,
  })

  Object.defineProperty(routerHistory, 'state', {
    enumerable: true,
    get: () => historyNavigation.state.value,
  })

  return routerHistory
}
