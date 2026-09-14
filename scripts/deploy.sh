#!/usr/bin/env bash
# 自动部署 dist/ 到 Vercel 的 ra2vm 项目。
#
# 用法：
#   scripts/deploy.sh             # 构建 + 生产部署
#   scripts/deploy.sh --no-build  # 跳过构建，直接部署现有 dist/
#   scripts/deploy.sh --preview   # 部署预览环境（不挂生产别名）
#
# 必须显式设置 VERCEL_SCOPE；脚本不会猜测账号或团队 scope。
# 前提：本机已执行过 `vercel login`（或配置 VERCEL_TOKEN）。
set -euo pipefail

PROJECT=ra2vm
if [[ -z "${VERCEL_SCOPE:-}" ]]; then
  echo "[deploy] 请显式设置 VERCEL_SCOPE，再执行部署。" >&2
  exit 1
fi
SCOPE="$VERCEL_SCOPE"
SCOPE_ARGS=(--scope "$SCOPE")

NO_BUILD=0
PREVIEW=0
for arg in "$@"; do
  case "$arg" in
    --no-build) NO_BUILD=1 ;;
    --preview) PREVIEW=1 ;;
    *) echo "[deploy] 未知参数：$arg" >&2; exit 1 ;;
  esac
done

# 1. 登录检查。
if ! vercel whoami >/dev/null 2>&1; then
  echo "[deploy] 尚未登录 Vercel，请先执行 vercel login。" >&2
  exit 1
fi

# 2. 构建（除非 --no-build）。
if [[ $NO_BUILD -eq 0 ]]; then
  echo "[deploy] 构建 dist/ ..."
  pnpm run build
fi
[[ -f dist/index.html ]] || { echo "[deploy] dist/index.html 不存在，请先构建。" >&2; exit 1; }

# 3. 首次运行时 link 项目（生成 .vercel/project.json，已 Git 忽略）。
if [[ ! -f .vercel/project.json ]]; then
  echo "[deploy] link 项目 $PROJECT ..."
  vercel link --yes --project "$PROJECT" "${SCOPE_ARGS[@]}"
fi

# 4. vercel deploy 以部署目录 dist/ 自身为上下文解析 link，
#    根目录的 project.json 读不到，所以先复制进 dist/（每次构建会清空 dist/）。
mkdir -p dist/.vercel
cp .vercel/project.json dist/.vercel/

# 5. 部署。--prod 直接挂生产别名；--preview 只生成预览链接。
PROD_ARGS=()
[[ $PREVIEW -eq 0 ]] && PROD_ARGS=(--prod)
vercel deploy dist --yes "${PROD_ARGS[@]}" "${SCOPE_ARGS[@]}"

echo "[deploy] 完成。"
