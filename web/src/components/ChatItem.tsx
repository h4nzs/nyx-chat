import OnlineDot from './OnlineDot'

export default function ChatItem({ title, online }: { title: string; online?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <OnlineDot online={!!online} />
      <span className="text-text-primary font-medium">{title}</span>
    </div>
  )
}