export default function Alert({ message }: { message: string }) {
  return <div role="alert" className="p-3 rounded-lg card-neumorphic text-destructive border border-destructive/30">{message}</div>
}