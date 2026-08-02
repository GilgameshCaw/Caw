#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Gecko orphan-composition watchdog patch for PostForm.tsx

真因(実測確定 2026-08-02):
  Gecko多枠で孤立compositionstart(data:"")が発火 → 対応するcompositionendが来ず
  isComposingRef および ネイティブcomposition が true のまま滞留 → 以降のBSが
  composition中扱いでネイティブ削除を抑制され無反応。

判定(実測2パターンで確定):
  正常変換: compositionstart → input(data有り)来る → compositionend
  孤立    : compositionstart(data:"") → input来ない → keydownのみ → 滞留
  ★差分 = compositionstart後にinputが来るか否か

修正(番犬):
  compositionstartで700msタイマー開始 + そのtextareaにネイティブinputリスナー直付け。
  input来たら正常変換 → cancel。700ms経過してもinput無し & まだcomposing →
  孤立確定 → isComposingRef=false + textarea.blur()→focus() でネイティブcomposition
  を強制終了(石板L17の機序をコード化)、caret復元。

安全境界:
  - 全処理 IS_GECKO gate内。Blink/WebKitは#37 isThreadMode=false=多枠パス踏まない=無傷。
  - cancelはネイティブinputリスナーで拾う=React onChange経路(handleTextChange/インライン)の
    分岐に依存しない=どのchunk枠でも確実。
  - handleCompositionStartの()=>契約(e.data非依存=Android WebView偽陽性回避)に触らない。
  - blur対象はactiveElement(実測: compstart時 activeEl===target 確認済)。TEXTAREA限定ガード。

掟: scp転送(直貼り厳禁) / dry-run(--dry) / bundle hash確認 / SW世代交代 / 三面回帰。
冪等: 適用済みなら SENTINEL 検出でno-op。
"""

import sys
import re
import shutil
import datetime

TARGET = "PostForm.tsx"  # このスクリプトと同じ components/ ディレクトリで実行する
SENTINEL = "orphanCompTimerRef"  # 冪等判定マーカー

# ---- アンカー(実ファイルの実文字列。sed事故回避のため広めに一意指定) ----

# [1] ref宣言: 519 isComposingRef の直後に番犬用ref群を追加
ANCHOR_REF = "  const isComposingRef = useRef(false)\n"
INSERT_REF = (
    "  const isComposingRef = useRef(false)\n"
    "  // Gecko orphan-composition watchdog (真因: 孤立compositionstartに対応する\n"
    "  // compositionendが来ずisComposingRef+ネイティブcompositionがtrue滞留→BS抑制)。\n"
    "  // タイマーhandle / 一時inputリスナーのcleanup / 監視対象textareaを保持。\n"
    "  const orphanCompTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)\n"
    "  const orphanInputCleanupRef = useRef<(() => void) | null>(null)\n"
)

# [2] 共通cancel関数 + handleCompositionStart(906)にタイマー開始を注入。
#     既存の handleCompositionStart 全体を置換。
ANCHOR_COMPSTART = (
    "  const handleCompositionStart = () => {\n"
    "    isComposingRef.current = true\n"
    "    lastComposedRef.current = null\n"
    "  }\n"
)
INSERT_COMPSTART = (
    "  // 番犬タイマー/一時リスナーを畳む共通cancel。正常変換のinput検出時、\n"
    "  // compositionend時、次のcompositionstart時、いずれからも安全に呼べる(冪等)。\n"
    "  const cancelOrphanWatchdog = () => {\n"
    "    if (orphanCompTimerRef.current !== null) {\n"
    "      clearTimeout(orphanCompTimerRef.current)\n"
    "      orphanCompTimerRef.current = null\n"
    "    }\n"
    "    if (orphanInputCleanupRef.current !== null) {\n"
    "      orphanInputCleanupRef.current()\n"
    "      orphanInputCleanupRef.current = null\n"
    "    }\n"
    "  }\n"
    "\n"
    "  const handleCompositionStart = () => {\n"
    "    isComposingRef.current = true\n"
    "    lastComposedRef.current = null\n"
    "    // Gecko限定・多枠のみ番犬を仕掛ける。Blink/WebKitはこの多枠パスに来ない(#37)。\n"
    "    if (!IS_GECKO) return\n"
    "    cancelOrphanWatchdog() // 前回の取りこぼしがあれば先に畳む\n"
    "    // compstart時のactiveElementが発生枠(実測: activeEl===target一致)。\n"
    "    const el = document.activeElement as HTMLTextAreaElement | null\n"
    "    if (!el || el.tagName !== 'TEXTAREA') return\n"
    "    // 正常変換は必ずinputが続く(実測: data有りinput)。孤立はinputが来ない。\n"
    "    // ネイティブinputを直接聞く=React onChange経路の分岐に依存しない。\n"
    "    let sawInput = false\n"
    "    const onInput = () => { sawInput = true }\n"
    "    el.addEventListener('input', onInput, true)\n"
    "    orphanInputCleanupRef.current = () => {\n"
    "      el.removeEventListener('input', onInput, true)\n"
    "    }\n"
    "    orphanCompTimerRef.current = setTimeout(() => {\n"
    "      orphanCompTimerRef.current = null\n"
    "      // cleanupは最後に必ず呼ぶ(リスナー除去)。\n"
    "      const cleanup = orphanInputCleanupRef.current\n"
    "      orphanInputCleanupRef.current = null\n"
    "      if (cleanup) cleanup()\n"
    "      // input来た=正常変換=何もしない。\n"
    "      if (sawInput) return\n"
    "      // input無し & まだcomposing扱い=孤立確定。\n"
    "      if (!isComposingRef.current) return\n"
    "      isComposingRef.current = false\n"
    "      lastComposedRef.current = null\n"
    "      // ネイティブcompositionはblurで強制終了する(石板L17: フォーカス外すと復活の機序)。\n"
    "      // isComposingRef=falseだけではネイティブは解けない(実測: BS keydown native=true滞留)。\n"
    "      if (document.activeElement === el && el.tagName === 'TEXTAREA') {\n"
    "        const caret = el.selectionStart\n"
    "        const caretEnd = el.selectionEnd\n"
    "        el.blur()\n"
    "        el.focus({ preventScroll: true })\n"
    "        // caret復元(blur/focusで先頭に飛ぶ個体差を吸収)。\n"
    "        try {\n"
    "          if (caret !== null && caretEnd !== null) {\n"
    "            el.setSelectionRange(caret, caretEnd)\n"
    "          }\n"
    "        } catch { /* no-op */ }\n"
    "      }\n"
    "    }, 700)\n"
    "  }\n"
)

# [3] handleCompositionEnd(915) 正常終了 → cancel
ANCHOR_COMPEND = (
    "  const handleCompositionEnd = (e: React.CompositionEvent<HTMLTextAreaElement>) => {\n"
    "    isComposingRef.current = false\n"
)
INSERT_COMPEND = (
    "  const handleCompositionEnd = (e: React.CompositionEvent<HTMLTextAreaElement>) => {\n"
    "    isComposingRef.current = false\n"
    "    cancelOrphanWatchdog() // 正常にendが来た=孤立ではない。番犬を畳む。\n"
)

# [4] makeChunkCompositionEnd(943) 多枠正常終了 → cancel
ANCHOR_CHUNKEND = (
    "  const makeChunkCompositionEnd = (i: number) =>\n"
    "    (e: React.CompositionEvent<HTMLTextAreaElement>) => {\n"
    "      isComposingRef.current = false\n"
)
INSERT_CHUNKEND = (
    "  const makeChunkCompositionEnd = (i: number) =>\n"
    "    (e: React.CompositionEvent<HTMLTextAreaElement>) => {\n"
    "      isComposingRef.current = false\n"
    "      cancelOrphanWatchdog() // 正常にendが来た(多枠)=孤立ではない。番犬を畳む。\n"
)

PATCHES = [
    ("ref宣言(519直後)", ANCHOR_REF, INSERT_REF),
    ("cancel関数+番犬注入(handleCompositionStart)", ANCHOR_COMPSTART, INSERT_COMPSTART),
    ("compositionend cancel(915)", ANCHOR_COMPEND, INSERT_COMPEND),
    ("makeChunkCompositionEnd cancel(943)", ANCHOR_CHUNKEND, INSERT_CHUNKEND),
]


def main():
    dry = "--dry" in sys.argv
    path = TARGET

    with open(path, "r", encoding="utf-8") as f:
        src = f.read()

    if SENTINEL in src:
        print("SKIP: 既に適用済み (SENTINEL '%s' 検出)。no-op。" % SENTINEL)
        return 0

    out = src
    applied = []
    for name, anchor, insert in PATCHES:
        cnt = out.count(anchor)
        if cnt != 1:
            print("ABORT: アンカー『%s』が %d 箇所 (期待:1)。中断=何も書かない。" % (name, cnt))
            print("  → 行ズレ or 既変更の可能性。実ファイルをsedせず目視確認せよ(表示≠真実)。")
            return 2
        out = out.replace(anchor, insert, 1)
        applied.append(name)

    # 挿入後サニティ: 主要トークンの存在確認(回数期待は行構成変化で誤検知するので存在のみ)
    for tok in ("orphanCompTimerRef", "cancelOrphanWatchdog", "orphanInputCleanupRef"):
        if tok not in out:
            print("ABORT: 挿入後サニティ失敗、トークン '%s' 不在。" % tok)
            return 2
    # cancelOrphanWatchdog は定義1 + 呼び出し3(start/end/chunkEnd) = 最低4回出るはず
    if out.count("cancelOrphanWatchdog") < 4:
        print("ABORT: cancelOrphanWatchdog 出現 %d 回 (期待>=4)。呼び出し漏れ疑い。"
              % out.count("cancelOrphanWatchdog"))
        return 2

    if dry:
        drypath = "/tmp/PostForm.tsx.dry"
        with open(drypath, "w", encoding="utf-8") as f:
            f.write(out)
        print("DRY-RUN OK: %d ブロック適用可能。書き出し=%s" % (len(applied), drypath))
        for a in applied:
            print("  ✓ " + a)
        print("→ diff確認: diff -u %s %s" % (path, drypath))
        return 0

    # 本適用: .bak取ってから書く
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    bak = "%s.bak.orphan.%s" % (path, stamp)
    shutil.copy2(path, bak)
    with open(path, "w", encoding="utf-8") as f:
        f.write(out)
    print("APPLIED: %d ブロック。bak=%s" % (len(applied), bak))
    for a in applied:
        print("  ✓ " + a)
    return 0


if __name__ == "__main__":
    sys.exit(main())
