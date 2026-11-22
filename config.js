// En github.io usa el Supabase de verdad; en local, el de pruebas (supabase start)
window.NOTAS_CONFIG = location.hostname.endsWith("github.io")
  ? { url: "https://fxxxsngoimewomkhcrbu.supabase.co", anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ4eHhzbmdvaW1ld29ta2hjcmJ1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUzNjc2MDMsImV4cCI6MjExMDk0MzYwM30._nQOEMtokechpDcK3ggwQyb7v6Zt9VATpAcLwYT7phk" }
  : { url: "http://127.0.0.1:55321", anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0" };
