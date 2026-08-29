#!/usr/bin/env bash
# PDF 页渲染脚本（leow3bot pdf skill）：扫描型 PDF → PNG，供 view 查看。
# 用法: render.sh <file.pdf> --pages 1,3,5-8 [--dpi 150]
#
# 输出固定为 ${TMPDIR}/leow3bot-pdf/<内容hash>-p<页码3位>.png——
# 同一文件同一页永远产出同一路径（重复渲染直接覆盖，不堆积文件；
# 模型重复查看直接 view 已有 PNG 即可）。
set -euo pipefail

file="" pages="" dpi=150
while [[ $# -gt 0 ]]; do
  case "$1" in
    --pages) pages="$2"; shift 2 ;;
    --dpi)   dpi="$2";   shift 2 ;;
    *)       file="$1";  shift ;;
  esac
done

if [[ -z "$file" || ! -f "$file" ]]; then
  echo "用法: render.sh <file.pdf> --pages 1,3,5-8 [--dpi 150]" >&2
  exit 1
fi

if ! command -v pdftoppm >/dev/null 2>&1; then
  echo "缺少依赖 poppler-utils（渲染 PDF 页需要）。安装:" >&2
  echo "  Debian/WSL: sudo apt install poppler-utils" >&2
  echo "  macOS:      brew install poppler" >&2
  exit 1
fi

file="$(readlink -f "$file")"
total=$(pdfinfo "$file" | awk '/^Pages:/{print $2}')
hash=$(sha256sum "$file" | cut -c1-12)
outdir="${TMPDIR:-/tmp}/leow3bot-pdf"
mkdir -p "$outdir"

# 展开页码列表: "1,3,5-8" → 1 3 5 6 7 8
expand_pages() {
  local IFS=','
  for part in $1; do
    if [[ "$part" == *-* ]]; then
      seq "${part%-*}" "${part#*-}"
    else
      echo "$part"
    fi
  done
}

if [[ -z "$pages" ]]; then
  echo "未指定 --pages。扫描件勿全量渲染——先渲染 1-3 页定位，再按需定向渲染:" >&2
  echo "  render.sh \"$file\" --pages 1-3" >&2
  exit 1
fi

rendered=()
for p in $(expand_pages "$pages"); do
  # 钳制页码范围，防模型传 0/负数/超界
  if ! [[ "$p" =~ ^[0-9]+$ ]] || (( p < 1 || p > total )); then
    echo "跳过无效页码: $p（共 $total 页）" >&2
    continue
  fi
  pdftoppm -r "$dpi" -png -f "$p" -l "$p" "$file" "$outdir/${hash}-tmp" >/dev/null 2>&1
  # pdftoppm 输出带总页数宽度的后缀（如 -tmp-01.png），统一重命名为 p001 风格
  tmpfile=$(ls "$outdir/${hash}-tmp"*.png 2>/dev/null | head -1)
  [[ -z "$tmpfile" ]] && { echo "第 $p 页渲染失败" >&2; continue; }
  dst="$outdir/${hash}-p$(printf '%03d' "$p").png"
  mv -f "$tmpfile" "$dst"
  rendered+=("$dst")
done

if [[ ${#rendered[@]} -eq 0 ]]; then
  echo "没有渲染出任何页面" >&2
  exit 1
fi

echo "已渲染 ${#rendered[@]} 页（${dpi} DPI，共 $total 页）:"
for f in "${rendered[@]}"; do
  echo "  $f"
done
echo "用 view 逐张查看（每轮 ≤2 张可获最高清晰度）。"
echo "同一页重复查看直接 view 以上路径（重新渲染也是同一路径）。"
