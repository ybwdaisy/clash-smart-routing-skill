# Managed by clash-smart-routing proxy. Only this wrapper changes the parent shell.
[[ ${path[1]:-} == "$HOME/.local/bin" ]] || path=("$HOME/.local/bin" "${path[@]}")
export PATH
rehash
unalias proxy clash-net 2>/dev/null
proxy() {
  local action=${1:-on} code result
  case "$action" in
    on)
      code=$(command proxy env --shell zsh --fresh) || return $?
      export PROXY_SHELL_MODE=auto
      eval "$code"
      [[ ${2:-} == --quiet ]] || command proxy status --brief
      ;;
    off)
      export PROXY_SHELL_MODE=off
      unset http_proxy https_proxy all_proxy no_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY PROXY_CONTEXT
      _PROXY_HTTP_PORT=''
      print '当前终端代理已关闭；GUI 与其他终端保持不变。'
      ;;
    *) command proxy "$@" ;;
  esac
}
_proxy_refresh() {
  [[ ${PROXY_SHELL_MODE:-auto} == off ]] && return 0
  local env_file="${PROXY_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/proxy}/shell-env.zsh" code
  if [[ -r "$env_file" ]]; then
    code=$(<"$env_file")
    if [[ "$code" != "${_PROXY_LAST_ENV:-}" ]]; then
      source "$env_file"
      _PROXY_LAST_ENV=$code
    fi
  fi
  return 0
}
_proxy_preexec() {
  _proxy_refresh
  [[ ${PROXY_SHELL_MODE:-auto} == off || -z ${_PROXY_HTTP_PORT:-} ]] && return 0
  zmodload zsh/net/tcp 2>/dev/null || return 0
  local descriptor code
  if ztcp 127.0.0.1 "$_PROXY_HTTP_PORT" 2>/dev/null; then
    descriptor=$REPLY; ztcp -c "$descriptor"
  else
    code=$(command proxy env --shell zsh --fresh --quiet) || code='unset http_proxy https_proxy all_proxy no_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY PROXY_CONTEXT; _PROXY_HTTP_PORT=""'
    eval "$code"
  fi
  return 0
}
autoload -Uz add-zsh-hook
add-zsh-hook -d precmd _proxy_refresh 2>/dev/null
add-zsh-hook -d preexec _proxy_preexec 2>/dev/null
add-zsh-hook precmd _proxy_refresh
add-zsh-hook preexec _proxy_preexec
_proxy_refresh
