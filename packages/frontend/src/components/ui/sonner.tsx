import { Toaster as Sonner } from "sonner"

function Toaster() {
  return (
    <Sonner
      theme="dark"
      position="top-center"
      expand
      gap={6}
      duration={8000}
      className="toaster group"
      toastOptions={{
        style: {
          padding: "8px 14px",
          minHeight: "unset",
          fontSize: "12px",
          background: "#2a2a2a",
          color: "#e0e0e0",
          border: "1px solid #3a3a3a",
        },
      }}
    />
  )
}

export { Toaster }
