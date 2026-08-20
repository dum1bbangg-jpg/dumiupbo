/* Supabase project settings. The anon key is meant to be public: write access
   is granted by the row level security policies in supabase.sql, not by hiding
   this key. Never put the service_role key here - that one goes in Cloudflare
   environment variables only. */
window.DOOMI_CONFIG = {
  SUPABASE_URL: "https://mowhwzpcenwtlmososag.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1vd2h3enBjZW53dGxtb3Nvc2FnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcyMTM5ODIsImV4cCI6MjEwMjc4OTk4Mn0.DhM1FRwVoJ-m-8Q9uGyFT5eydBNq7poDfVE8-gd9B0o",

  /* Optional. 두미의 SOOP 아이디를 넣으면 사이드바 프로필 사진을 SOOP에서
     원본 해상도로 가져옵니다. 비워 두면 assets/doomi-profile.png를 씁니다. */
  SOOP_ID: ""
};
