import React from 'react';

interface MarkdownMessageProps {
  content: string;
}

const MarkdownMessage: React.FC<MarkdownMessageProps> = ({ content }) => {
  // Function to parse markdown and convert to react elements safely
  const parseMarkdown = (text: string): JSX.Element[] => {
    // Split text by potential markdown elements
    // First handle code blocks (```...```)
    const codeBlockRegex = /(```[\s\S]*?```|`[^`\n]*`)/g;
    const parts = text.split(codeBlockRegex);

    return parts.map((part, index) => {
      // If it's a code block
      if (part.startsWith('```') && part.endsWith('```')) {
        const codeContent = part.slice(3, -3);
        return (
          <code key={index} className="block bg-secondary p-2 rounded-md my-1 text-sm font-mono overflow-x-auto">
            {codeContent}
          </code>
        );
      } else if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
        const inlineCode = part.slice(1, -1);
        return (
          <code key={index} className="bg-secondary px-1.5 py-0.5 rounded text-sm font-mono">
            {inlineCode}
          </code>
        );
      } else {
        // Process other inline markdown elements
        return processInlineMarkdown(part, index);
      }
    });
  };

  // Helper function to apply simple regex formatting
  const processSimpleRegex = (
    text: string,
    regex: RegExp,
    type: 'bold' | 'italic' | 'strikethrough',
    key: number
  ): (string | JSX.Element)[] => {
    const parts: (string | JSX.Element)[] = [];
    let lastIndex = 0;

    // Reset regex state in case it's used multiple times
    regex.lastIndex = 0;

    let match;
    while ((match = regex.exec(text)) !== null) {
      // Add text before the match
      if (match.index > lastIndex) {
        parts.push(text.substring(lastIndex, match.index));
      }

      // Add formatted content (the captured group)
      const content = match[1];
      if (type === 'bold') {
        parts.push(<strong key={`${key}-${match.index}`}>{content}</strong>);
      } else if (type === 'italic') {
        parts.push(<em key={`${key}-${match.index}`}>{content}</em>);
      } else if (type === 'strikethrough') {
        parts.push(<del key={`${key}-${match.index}`}>{content}</del>);
      }

      lastIndex = match.index + match[0].length;
    }

    // Add remaining text after the last match
    if (lastIndex < text.length) {
      parts.push(text.substring(lastIndex));
    }

    return parts;
  };

  // Function to process inline markdown (bold, italic, strikethrough)
  const processInlineMarkdown = (text: string, key: number): JSX.Element => {
    // Process the text sequentially for different markdown elements
    let parts: (string | JSX.Element)[] = [text];

    // Handle code first to avoid conflicts with other formats inside code
    parts = parts.flatMap(item => {
      if (typeof item === 'string') {
        // Split by code delimiters but keep the delimiters
        const subParts = item.split(/(`.*?`)/g);
        return subParts.map((part, idx) => {
          if (idx % 2 === 1) { // Odd indexes are code blocks (the parts that matched the delimiter)
            // Remove the backticks and return code element
            const codeContent = part.slice(1, -1);
            return <code key={`code-${key}-${idx}`} className="bg-secondary px-1.5 py-0.5 rounded text-sm font-mono">{codeContent}</code>;
          }
          return part; // Non-code parts
        });
      }
      return item;
    });

    // Process remaining parts for other formatting
    parts = parts.flatMap(item => {
      if (typeof item === 'string') {
        // Process bold (**text** and __text__)
        let subParts: (string | JSX.Element)[] = [item];
        
        // Process **bold** first
        subParts = subParts.flatMap(subItem => {
          if (typeof subItem === 'string') {
            return processSimpleRegex(subItem, /\*\*(.*?)\*\*/g, 'bold', key);
          }
          return subItem;
        });
        
        // Process __bold__ (double underscore)
        subParts = subParts.flatMap(subItem => {
          if (typeof subItem === 'string') {
            return processSimpleRegex(subItem, /__(.*?)__/g, 'bold', key);
          }
          return subItem;
        });
        
        // Process ~~strikethrough~~
        subParts = subParts.flatMap(subItem => {
          if (typeof subItem === 'string') {
            return processSimpleRegex(subItem, /~~(.*?)~~/g, 'strikethrough', key);
          }
          return subItem;
        });
        
        // Process *italic* (single asterisk) - need to be careful not to match inside words
        subParts = subParts.flatMap(subItem => {
          if (typeof subItem === 'string') {
            // Use word boundaries to ensure that * is not in the middle of a word
            // This regex matches *text* where text is surrounded by word boundaries
            return processSimpleRegex(subItem, /\B\*([^\*]+?)\*\B/g, 'italic', key);
          }
          return subItem;
        });
        
        // Process _italic_ (single underscore)
        subParts = subParts.flatMap(subItem => {
          if (typeof subItem === 'string') {
            // Use word boundaries to ensure that _ is not in the middle of a word
            return processSimpleRegex(subItem, /\B_([^_]+?)_\B/g, 'italic', key);
          }
          return subItem;
        });

        return subParts;
      }
      return item;
    });

    return <React.Fragment key={key}>{parts}</React.Fragment>;
  };

  return <div className="markdown-content whitespace-pre-wrap">{parseMarkdown(content)}</div>;
};

export default MarkdownMessage;