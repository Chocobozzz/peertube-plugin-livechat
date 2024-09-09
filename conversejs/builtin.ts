// SPDX-FileCopyrightText: 2024 John Livingston <https://www.john-livingston.fr/>
//
// SPDX-License-Identifier: AGPL-3.0-only

/* eslint-disable @typescript-eslint/no-unsafe-function-type */

import type { InitConverseJSParams, ChatIncludeMode, ExternalAuthResult } from 'shared/lib/types'
import { inIframe } from './lib/utils'
import { initDom } from './lib/dom'
import {
  defaultConverseParams,
  localRoomAnonymousParams,
  localRoomAuthenticatedParams,
  remoteRoomAnonymousParams,
  remoteRoomAuthenticatedParams
} from './lib/converse-params'
import { getLocalAuthentInfos, getLivechatTokenAuthInfos } from './lib/auth'
import { randomNick } from './lib/nick'
import { slowModePlugin } from './lib/plugins/slow-mode'
import { windowTitlePlugin } from './lib/plugins/window-title'
import { livechatSpecificsPlugin } from './lib/plugins/livechat-specific'
import { livechatViewerModePlugin } from './lib/plugins/livechat-viewer-mode'
import { livechatMiniMucHeadPlugin } from './lib/plugins/livechat-mini-muc-head'
import { livechatEmojisPlugin } from './lib/plugins/livechat-emojis'
import { moderationDelayPlugin } from './lib/plugins/moderation-delay'

declare global {
  interface Window {
    converse: {
      initialize: (args: any) => void
      plugins: {
        add: (name: string, plugin: any) => void
      }
      emojis: any
      livechatDisconnect?: Function
      env: {
        html: Function
        sizzle: Function
        dayjs: Function
      }
    }
    initConversePlugins: typeof initConversePlugins
    initConverse: typeof initConverse
    reconnectConverse?: (params: any) => void
    externalAuthGetResult?: (data: ExternalAuthResult) => void
  }
}

/**
 * Initilialize ConverseJS plugins.
 * @param peertubeEmbedded true if we are embedded in Peertube, false if it is the old full page mode.
 */
function initConversePlugins (peertubeEmbedded: boolean): void {
  const converse = window.converse

  if (!peertubeEmbedded) {
    // When in full page mode, this plugin ensure the window title is equal to the room title.
    converse.plugins.add('livechatWindowTitlePlugin', windowTitlePlugin)
  }

  // Slow mode
  converse.plugins.add('converse-slow-mode', slowModePlugin)

  // livechatSpecifics plugins add some customization for the livechat plugin.
  converse.plugins.add('livechatSpecifics', livechatSpecificsPlugin)

  // Channels emojis.
  converse.plugins.add('livechatEmojis', livechatEmojisPlugin)

  if (peertubeEmbedded) {
    // This plugins handles some buttons that are generated by Peertube, to include them in the MUC menu.
    converse.plugins.add('livechatMiniMucHeadPlugin', livechatMiniMucHeadPlugin)
  }

  // Viewer mode (anonymous accounts, before they have chosen their nickname).
  converse.plugins.add('livechatViewerModePlugin', livechatViewerModePlugin)

  converse.plugins.add('converse-moderation-delay', moderationDelayPlugin)
}
window.initConversePlugins = initConversePlugins

/**
 * Init ConverseJS
 * @param initConverseParams ConverseJS init Params
 * @param chatIncludeMode How the chat is included in the html page
 * @param peertubeAuthHeader when embedded in Peertube, we can get the header from peertubeHelpers
 */
async function initConverse (
  initConverseParams: InitConverseJSParams,
  chatIncludeMode: ChatIncludeMode = 'chat-only',
  peertubeAuthHeader?: Record<string, string> | null
): Promise<void> {
  // First, fixing relative websocket urls.
  if (initConverseParams.localWebsocketServiceUrl?.startsWith('/')) {
    initConverseParams.localWebsocketServiceUrl = new URL(
      initConverseParams.localWebsocketServiceUrl,
      (window.location.protocol === 'http:' ? 'ws://' : 'wss://') + window.location.host
    ).toString()
  }

  const {
    isRemoteChat,
    remoteAnonymousXMPPServer,
    remoteAuthenticatedXMPPServer,
    authenticationUrl,
    autoViewerMode,
    forceReadonly
  } = initConverseParams

  const converse = window.converse

  const isInIframe = inIframe()
  initDom(initConverseParams, isInIframe)

  // Autofocus: false if besides video, or if an external iframe
  initConverseParams.autofocus = (chatIncludeMode === 'peertube-fullpage') ||
    (chatIncludeMode === 'chat-only' && !isInIframe)

  // hide participant if in an external iframe, or besides video.
  initConverseParams.forceDefaultHideMucParticipants = (isInIframe || chatIncludeMode === 'peertube-video')

  const params = defaultConverseParams(initConverseParams)
  params.view_mode = chatIncludeMode === 'chat-only' ? 'fullscreen' : 'embedded'
  params.allow_url_history_change = chatIncludeMode === 'chat-only'

  let isAuthenticated = false
  let isAuthenticatedWithExternalAccount = false
  let isRemoteWithNicknameSet = false

  // OIDC (OpenID Connect):
  const tryOIDC = (initConverseParams.externalAuthOIDC?.length ?? 0) > 0

  let auth
  let usedLivechatToken = false
  if (chatIncludeMode === 'chat-only') {
    // In this mode, we can check if there is a token in the url.
    auth = getLivechatTokenAuthInfos()
    if (auth) { usedLivechatToken = true }
  }
  auth ??= await getLocalAuthentInfos(authenticationUrl, tryOIDC, peertubeAuthHeader)

  if (auth) {
    if (!isRemoteChat) {
      localRoomAuthenticatedParams(initConverseParams, auth, params)
      isAuthenticated = true
      isAuthenticatedWithExternalAccount = auth.type !== 'peertube'
    } else if (remoteAuthenticatedXMPPServer) {
      remoteRoomAuthenticatedParams(initConverseParams, auth, params)
      isAuthenticated = true
      isAuthenticatedWithExternalAccount = auth.type !== 'peertube'
    } else if (remoteAnonymousXMPPServer) {
      // remote server does not allow remote authenticated users, falling back to anonymous mode
      remoteRoomAnonymousParams(initConverseParams, auth, params)
      isRemoteWithNicknameSet = true
    } else {
      console.error('Remote server does not allow remote connection')
      params.jid = null
    }
  } else {
    if (!isRemoteChat) {
      localRoomAnonymousParams(initConverseParams, params)
    } else if (remoteAnonymousXMPPServer) {
      remoteRoomAnonymousParams(initConverseParams, null, params)
    } else {
      console.error('Remote server does not allow remote connection')
      params.jid = null
    }
  }

  if (params.jid === null) {
    if (chatIncludeMode === 'chat-only') {
      // Special use case: when mode=chat-only, and no params.jid: display an error page.
      // Note: this can happen if anonymous users are not allowed on the server.
      console.error('Seems that anonymous users are not allowed on the target server')
      // FIXME: localize?
      document.body.innerHTML = '<h1>This chatroom does not exist, or is not accessible to you.</h1>'
      return
    } else {
      throw new Error('Can\'t connect, no JID')
    }
  }

  if (!isAuthenticated) {
    console.log('User is not authenticated.')
    if (forceReadonly) {
      params.nickname = randomNick('Viewer')
    }
    // TODO: try to make these params work
    // params.muc_nickname_from_jid = true => compute the muc nickname from the jid (will be random here)
    // params.auto_register_muc_nickname = true => maybe not relevant here (dont do what i thought)
    // params.muc_show_logs_before_join = true => displays muc history on top of nickname form. But it's not updated.
  }

  // no viewer mode if authenticated.
  params.livechat_enable_viewer_mode = autoViewerMode && !isAuthenticated && !isRemoteWithNicknameSet

  params.livechat_specific_external_authent = isAuthenticatedWithExternalAccount
  params.livechat_specific_is_anonymous = !isAuthenticated

  if (tryOIDC && !isAuthenticated) {
    params.livechat_external_auth_oidc_buttons = initConverseParams.externalAuthOIDC
  }

  if (tryOIDC) { // also needed when authenticated (for the signout button)
    switch (chatIncludeMode) {
      case 'peertube-video':
        params.livechat_external_auth_reconnect_mode = 'button-close-open'
        break
      case 'peertube-fullpage':
      case 'chat-only':
      default:
        params.livechat_external_auth_reconnect_mode = 'reload'
    }
  }

  if (chatIncludeMode === 'peertube-video') {
    params.livechat_mini_muc_head = true // we must replace the muc-head by the custom buttons toolbar.
  }

  // We enable task list only if we are in the peertube interface, or if:
  // * mode === chat-only + !transparent + !readonly + is using a livechat token
  // Technically it would work in 'chat-only' mode, but i don't want to add too many things to test
  // (and i now there is some CSS bugs in the task list).
  // Same for the moderator notes app.
  let enableApps = false
  if (chatIncludeMode === 'peertube-video' || chatIncludeMode === 'peertube-fullpage') {
    enableApps = true
  } else if (
    chatIncludeMode === 'chat-only' &&
    usedLivechatToken &&
    !initConverseParams.transparent &&
    !initConverseParams.forceReadonly
  ) {
    enableApps = true
  }
  if (enableApps) {
    params.livechat_task_app_enabled = true
    params.livechat_task_app_restore = chatIncludeMode === 'peertube-fullpage' || chatIncludeMode === 'chat-only'
    params.livechat_note_app_enabled = true
    params.livechat_note_app_restore = chatIncludeMode === 'peertube-fullpage' || chatIncludeMode === 'chat-only'
    params.livechat_mam_search_app_enabled = true
  }

  try {
    if (window.reconnectConverse) { // this is set in the livechatSpecificsPlugin
      window.reconnectConverse(params)
    } else {
      converse.initialize(params)
    }
  } catch (error) {
    console.error('Failed initializing converseJS', error)
  }
}
window.initConverse = initConverse
