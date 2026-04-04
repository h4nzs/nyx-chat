import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';

// Definisikan tipe untuk node AST Markdown
interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
}

// ✅ Custom Plugin: Mencegah HTML dibuang, dan mengubahnya menjadi plain text biasa
const remarkHtmlToText = () => (tree: MarkdownNode) => {
  const walk = (node: MarkdownNode) => {
    if (node.type === 'html') {
      // Ubah tipe node dari 'html' menjadi 'text' agar dirender sebagai teks literal
      node.type = 'text';
    }
    if (node.children && Array.isArray(node.children)) {
      node.children.forEach(walk);
    }
  };
  walk(tree);
};

interface MarkdownMessageProps {
  content: string;
  isOwn?: boolean;
}

const MarkdownMessage: React.FC<MarkdownMessageProps> = ({ content, isOwn = false }) => {
  return (
    <div className="markdown-content whitespace-pre-wrap">
      <ReactMarkdown
        // ✅ Tambahkan remarkHtmlToText ke dalam array remarkPlugins
        remarkPlugins={[remarkGfm, remarkHtmlToText]}
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