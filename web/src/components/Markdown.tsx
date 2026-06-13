/**
 * Renders explanation markdown in the serif reading column. GitHub-flavoured
 * markdown (tables, task lists) is enabled; external links open safely in a new
 * tab. Styling lives entirely in the `.prose-reading` class (see index.css) so
 * the reading experience stays consistent everywhere it's used.
 */
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { clsx } from "clsx";

export function Markdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div className={clsx("prose-reading", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children, ...props }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
              {children}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
