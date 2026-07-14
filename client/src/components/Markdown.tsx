import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'

// Models emit LaTeX with \[ … \] (display) and \( … \) (inline) delimiters, but
// remark-math only recognises $…$ / $$…$$. Normalise the backslash delimiters to
// dollar form (paired, so we never convert a stray bracket) before parsing. Also
// tolerate a literal \\( style if a provider double-escapes.
function normalizeMath(src: string): string {
  return src
    .replace(/\\\\?\[([\s\S]*?)\\\\?\]/g, (_m, e) => `\n\n$$${e}$$\n\n`)
    .replace(/\\\\?\(([\s\S]*?)\\\\?\)/g, (_m, e) => `$${e}$`)
}

/** Render assistant text as GitHub-flavoured Markdown + KaTeX math, themed for
 * the dark cyber UI (see .chat-md in index.css). */
export function ChatMarkdown({ content }: { content: string }) {
  return (
    <div className="chat-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
      >
        {normalizeMath(content)}
      </ReactMarkdown>
    </div>
  )
}
