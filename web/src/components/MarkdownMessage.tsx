import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';

interface MarkdownMessageProps {
  content: string;
}

const MarkdownMessage: React.FC<MarkdownMessageProps> = ({ content }) => {
  return (
    <div className="markdown-content whitespace-pre-wrap">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          code({ inline, className, children, ...props }: any) {
            return inline ? (
              <code className="bg-secondary px-1.5 py-0.5 rounded text-sm font-mono" {...props}>
                {children}
              </code>
            ) : (
              <code className="block bg-secondary p-2 rounded-md my-1 text-sm font-mono overflow-x-auto" {...props}>
                {children}
              </code>
            );
          },
          a({ node, ...props }) {
            return (
              <a 
                {...props} 
                target="_blank" 
                rel="noreferrer" 
                className="text-accent hover:underline cursor-pointer"
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