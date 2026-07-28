 (cd "$(git rev-parse --show-toplevel)" && git apply --3way <<'EOF' 
diff --git a/src/app/api/registrations/route.ts b/src/app/api/registrations/route.ts
index 056c9d2075a8b44d685815f1f60521aff1e48c85..116192a8b6bffd09711cace1b80abd22d0d2d37b 100644
--- a/src/app/api/registrations/route.ts
+++ b/src/app/api/registrations/route.ts
@@ -27,138 +27,151 @@ export async function POST(req: Request) {
       );
     }
     if (!/^\d{9,11}$/.test(phone)) {
       return NextResponse.json({ error: "Số điện thoại không hợp lệ." }, { status: 400 });
     }
     if (!fullName) {
       return NextResponse.json({ error: "Thiếu họ và tên." }, { status: 400 });
     }
 
     const today = todayStr();
 
     const [dup] = await db
       .select({ id: dailyApplications.id })
       .from(dailyApplications)
       .where(and(eq(dailyApplications.cccd, cccd), eq(dailyApplications.regDate, today), isNull(dailyApplications.deletedAt)))
       .limit(1);
     if (dup) {
       return NextResponse.json(
         { error: "Đã xác nhận đăng ký hôm nay.", code: "ALREADY_REGISTERED_TODAY" },
         { status: 409 },
       );
     }
 
     // Đối chiếu DW Data (nguồn sự thật) — không phụ thuộc lời khai
     const match = await matchDwWorker({ cccd, fullName, dob: body.dob, phone });
-
-    // Validate câu hỏi động bắt buộc đang hiệu lực
-    const required = await db
-      .select()
-      .from(formQuestions)
-      .where(
-        and(
-          eq(formQuestions.isActive, true),
-          eq(formQuestions.isRequired, true),
-          sql`(${formQuestions.applyFrom} IS NULL OR ${formQuestions.applyFrom} <= ${today}::date)`,
-        ),
-      );
-    for (const q of required) {
-      if (!answers[q.fieldKey] || String(answers[q.fieldKey]).trim() === "") {
-        return NextResponse.json(
-          { error: `Thiếu câu trả lời bắt buộc: "${q.questionText}"` },
-          { status: 400 },
+    const [existingProfile] = body.is_returning
+      ? await db
+          .select()
+          .from(workerProfiles)
+          .where(and(eq(workerProfiles.cccd, cccd), isNull(workerProfiles.deletedAt)))
+          .limit(1)
+      : [];
+    const isReturningApplicant = Boolean(body.is_returning && (match.worker || existingProfile));
+
+    // Validate câu hỏi động bắt buộc đang hiệu lực. Chỉ bỏ qua khảo sát dành cho người mới
+    // khi yêu cầu quay lại đã đối chiếu được với DW hoặc worker profile hiện có ở phía server.
+    if (!isReturningApplicant) {
+      const required = await db
+        .select()
+        .from(formQuestions)
+        .where(
+          and(
+            eq(formQuestions.isActive, true),
+            eq(formQuestions.isRequired, true),
+            sql`(${formQuestions.applyFrom} IS NULL OR ${formQuestions.applyFrom} <= ${today}::date)`,
+          ),
         );
+      for (const q of required) {
+        if (!answers[q.fieldKey] || String(answers[q.fieldKey]).trim() === "") {
+          return NextResponse.json(
+            { error: `Thiếu câu trả lời bắt buộc: "${q.questionText}"` },
+            { status: 400 },
+          );
+        }
       }
     }
 
+    const gender = String(body.gender ?? answers.gioi_tinh ?? "").trim() || null;
+    const ethnicity = String(body.ethnicity ?? answers.dan_toc ?? "").trim() || null;
     const dobStr = String(body.dob ?? "").trim() || null;
     const year = dobStr?.match(/(19|20)\d{2}/)?.[0];
     const birthYear = year ? parseInt(year) : null;
     const computedAge = birthYear ? new Date().getFullYear() - birthYear : null;
 
     // RULE ENGINE (#6) — chạy các rule đang bật ở trigger ON_REGISTER (cấu hình tại /admin/rules).
     let ruleStatus: string | null = null;
     let ruleNote: string | null = null;
     const ruleActions = await runRules("daily_application", "ON_REGISTER", {
       age: computedAge,
-      gender: body.gender ?? null,
-      ethnicity: body.ethnicity ?? null,
+      gender,
+      ethnicity,
       dwMatch: match.status,
       declaredType: body.declared_type === "OLD" ? "OLD" : "NEW",
     });
     for (const a of ruleActions) {
       if (a.type === "SET_STATUS") ruleStatus = a.value;
       if (a.type === "FLAG_NOTE") ruleNote = ruleNote ? `${ruleNote}; ${a.value} (rule: ${a.ruleName})` : `${a.value} (rule: ${a.ruleName})`;
     }
 
     const [created] = await db
       .insert(dailyApplications)
       .values({
         regDate: today,
         cccd,
-        fullName: match.worker?.fullName ?? fullName,
-        gender: body.gender || match.worker?.gender || null,
-        dob: dobStr ?? match.worker?.bod ?? null,
+        fullName: match.worker?.fullName ?? existingProfile?.fullName ?? fullName,
+        gender: gender || match.worker?.gender || existingProfile?.gender || null,
+        dob: dobStr ?? match.worker?.bod ?? existingProfile?.dob ?? null,
         birthYear,
         age: computedAge,
         phone,
-        ethnicity: body.ethnicity || null,
-        permanentAddress: body.permanent_address || match.worker?.permanentAddress || null,
-        residentialAddress: body.residential_address || match.worker?.residentialAddress || null,
+        ethnicity,
+        permanentAddress: body.permanent_address || match.worker?.permanentAddress || existingProfile?.permanentAddress || null,
+        residentialAddress: body.residential_address || match.worker?.residentialAddress || existingProfile?.residentialAddress || null,
         declaredType: body.declared_type === "OLD" ? "OLD" : "NEW",
         dwMatch: match.status,
         dwId: match.worker?.id ?? null,
         dwCode: match.worker?.code ?? null,
         workDuration: body.work_duration || null,
         referralChannel: body.referral_channel || null,
         customAnswers: answers,
         status: ruleStatus ?? "PENDING",
         noteWorker: ruleNote,
       })
       .returning();
 
     // DIGITAL WORKER FILE (#10) — 1 người chỉ có 1 worker_profiles, mỗi lần đăng ký chỉ
     // tạo 1 employment_sessions gắn vào profile đó (KHÔNG tạo "người" mới mỗi lần quay lại).
     const [profile] = await db
       .insert(workerProfiles)
       .values({
         cccd,
-        fullName: match.worker?.fullName ?? fullName,
-        gender: body.gender || match.worker?.gender || null,
-        dob: dobStr ?? match.worker?.bod ?? null,
+        fullName: match.worker?.fullName ?? existingProfile?.fullName ?? fullName,
+        gender: gender || match.worker?.gender || existingProfile?.gender || null,
+        dob: dobStr ?? match.worker?.bod ?? existingProfile?.dob ?? null,
         phone,
-        permanentAddress: body.permanent_address || match.worker?.permanentAddress || null,
-        residentialAddress: body.residential_address || match.worker?.residentialAddress || null,
+        permanentAddress: body.permanent_address || match.worker?.permanentAddress || existingProfile?.permanentAddress || null,
+        residentialAddress: body.residential_address || match.worker?.residentialAddress || existingProfile?.residentialAddress || null,
         dwId: match.worker?.id ?? null,
       })
       .onConflictDoUpdate({
         target: workerProfiles.cccd,
         targetWhere: sql`deleted_at is null`,
         set: {
-          fullName: match.worker?.fullName ?? fullName,
+          fullName: match.worker?.fullName ?? existingProfile?.fullName ?? fullName,
           phone,
-          residentialAddress: body.residential_address || match.worker?.residentialAddress || null,
+          residentialAddress: body.residential_address || match.worker?.residentialAddress || existingProfile?.residentialAddress || null,
           updatedAt: new Date(),
         },
       })
       .returning();
 
     await db.insert(employmentSessions).values({
       workerId: profile.id,
       dailyApplicationId: created.id,
       regDate: today,
       status: created.status,
     });
 
     return NextResponse.json({
       success: true,
       application: created,
       dwMatch: match.status,
       confidence: match.confidence,
     });
   } catch (error) {
     return NextResponse.json(
       { error: "Lỗi hệ thống: " + (error as Error).message },
       { status: 500 },
     );
   }
 }
 
EOF
)
