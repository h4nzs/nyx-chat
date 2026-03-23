import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';

interface MarkdownMessageProps {
  content: string;
  isOwn?: boolean;
}

const MarkdownMessage: React.FC<MarkdownMessageProps> = ({ content, isOwn = false }) => {
  return (
    <div className="markdown-content whitespace-pre-wrap">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          code({ className, children, ...props }: React.HTMLProps<HTMLElement> & {inline?: boolean}) {
            const { inline, ...rest } = props;
            return (
              <code className="bg-secondary/50 px-1 py-0.5 rounded text-sm font-mono" {...rest}>
                {children}
              </code>
            );
          },
          pre({ children, ...props }: React.HTMLProps<HTMLPreElement>) {
            return (
              <pre {...props} className="block bg-secondary p-2 rounded-md my-1 text-sm font-mono overflow-x-auto [&>code]:bg-transparent [&>code]:p-0">
                {children}
              </pre>
            );
          },
          a({ node, ...props }) {
            return (
              <a 
                {...props} 
                target="_blank" 
                rel="noreferrer" 
                className={isOwn ? "text-white underline font-medium hover:text-white/80" : "text-accent hover:underline cursor-pointer"}
                onClick={(e) => e.stopPropagation()} 
              />
            );
          }
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
};

export default MarkdownMessage;