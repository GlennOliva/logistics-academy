import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  Link,
  NavLink,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useAuth } from "./auth";
import { Field, Loading, PageMeta, Status } from "./components/ui";
import { LearnCourse } from "./learn/LearnCourse";
import { FinalQuiz, KnowledgeCheck, ModuleLesson } from "./learn/Lesson";
import {
  AdminPaymentDetail,
  AdminPayments,
  StudentResubmit,
} from "./admin/Payments";
import { AdminCourseMaterial, AdminCourses } from "./admin/Courses";
import { AdminAudit, AdminReports, AdminStudents } from "./admin/Students";
import {
  emailDeliveryEnabled,
  isSupabaseConfigured,
  supabase,
  supabasePublishableKey,
  supabaseUrl,
} from "./lib/supabase";
import { formatCentavos, formatManilaDateTime, validateProofFile } from "./lib/payment";
import { useResource } from "./lib/useResource";
import { useEnrolledCourses } from "./learn/hooks";
import { signedInDestination } from "./lib/authRouting";
import {
  registrationErrorMessage,
  registrationSuccessMessage,
} from "./lib/registration";
import "./App.css";

const draftPolicyVersion = "development-draft-2026-10-03";
const appOrigin = (() => {
  const configured = import.meta.env.VITE_APP_ORIGIN?.trim();
  if (!configured) return window.location.origin;
  try {
    return new URL(configured).origin;
  } catch {
    return window.location.origin;
  }
})();

function Layout() {
  const { session, isAdmin } = useAuth();
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <Link
          className="brand"
          to="/"
          aria-label="Logistics VA Training Academy home"
        >
          <img src="/logo.svg" alt="" /> <span>Training Academy</span>
        </Link>
        <nav aria-label="Main navigation">
          <NavLink to="/courses/logistics-101">Course</NavLink>
          <NavLink to="/about">About</NavLink>
          <NavLink to="/faq">FAQ</NavLink>
          <NavLink to="/contact">Contact</NavLink>
          {session ? (
            <NavLink to="/dashboard">Dashboard</NavLink>
          ) : (
            <NavLink to="/login">Sign in</NavLink>
          )}
          {isAdmin && <NavLink to="/admin">Admin</NavLink>}
        </nav>
      </header>
      <main id="main">
        <Outlet />
      </main>
      <footer>
        <div className="footer-brand">
          <Link to="/" aria-label="Logistics VA Training Academy home">
            <img src="/logo.svg" alt="" />
          </Link>
          <p>Self-paced logistics training from Davao City, Philippines.</p>
        </div>
        <div className="footer-links">
          <Link to="/policies/privacy">Privacy</Link>
          <Link to="/policies/terms">Terms</Link>
          <Link to="/policies/payment">Payment</Link>
          <Link to="/policies/refund">Refunds</Link>
        </div>
      </footer>
    </>
  );
}

function Home() {
  return (
    <>
      <PageMeta
        title="Learn logistics with a working roadmap"
        description="Beginner-friendly, self-paced Logistics 101 training in English and Bisaya."
      />
      <section className="hero-section">
        <div className="eyebrow">From first load to final handoff</div>
        <h1>Build the skills behind a logistics VA career.</h1>
        <p className="lede">
          A practical, beginner-friendly introduction to U.S. logistics and 3PL
          freight brokerage, taught at your pace in English or Bisaya.
        </p>
        <div className="actions">
          <Link className="button" to="/courses/logistics-101">
            Explore Logistics 101
          </Link>
          <Link className="text-link" to="/about">
            Meet your trainer
          </Link>
        </div>
        <div className="price-card">
          <small>One-time course price</small>
          <strong>₱699</strong>
          <span>Manual payment · verification may take up to 24 hours</span>
        </div>
      </section>
      <section className="process">
        <div>
          <span>01</span>
          <h2>Register</h2>
          <p>Create your student account before making a payment.</p>
        </div>
        <div>
          <span>02</span>
          <h2>Submit proof</h2>
          <p>
            Use a configured payment method and upload your receipt securely.
          </p>
        </div>
        <div>
          <span>03</span>
          <h2>Learn</h2>
          <p>
            Approval unlocks self-paced lessons, progress tracking and
            assessments.
          </p>
        </div>
      </section>
      <section className="split">
        <div>
          <p className="eyebrow">Made for new starters</p>
          <h2>No logistics experience required.</h2>
          <p>
            Learn core workflows for aspiring logistics coordinators,
            dispatchers, track-and-trace specialists, logistics VAs and career
            shifters.
          </p>
        </div>
        <div className="feature-list">
          <p>English and Bisaya options</p>
          <p>Mobile-friendly lessons</p>
          <p>Module knowledge checks</p>
          <p>Final quiz and verifiable certificate</p>
          <p>Lifetime access under the published terms</p>
        </div>
      </section>
      <section className="trainer-band">
        <div>
          <p className="eyebrow">Your trainer</p>
          <h2>Angela Valiente</h2>
          <p>
            Angela brings eight years of client-provided experience across
            carrier sales, logistics coordination, customer success, account
            management and logistics quality analysis in major U.S. logistics
            companies.
          </p>
          <Link className="text-link light" to="/about">
            Read Angela's story
          </Link>
        </div>
      </section>
    </>
  );
}

const knownModules = [
  "Logistics Fundamentals",
  "Trucks & Equipment",
  "Carrier Sourcing",
  "Booking and Rate Negotiation",
  "Documents",
  "Dispatch and Track and Trace",
  "Accessorials",
  "Delivery and Load Closing",
];
function Course() {
  return (
    <div className="page">
      <PageMeta
        title="Logistics 101"
        description="Explore the Logistics 101 curriculum, payment process and certificate requirements."
      />
      <p className="eyebrow">Flagship course</p>
      <h1>Logistics 101</h1>
      <p className="lede">
        A self-paced foundation for logistics VA work and 3PL freight brokerage.
      </p>
      <img
        className="course-thumbnail"
        src="/logistics-101-thumbnail.svg"
        alt="Logistics 101 course by Logistics VA Training Academy"
      />
      <div className="course-grid">
        <section>
          <h2>Curriculum status</h2>
          <p>
            All eight module titles are trainer-approved. Required English and
            Bisaya lesson files and module knowledge checks remain launch
            requirements.
          </p>
          <ol className="curriculum">
            {knownModules.map((name, index) => (
              <li key={name}>
                <span>Module {index + 1}</span>
                {name}
                <small>
                  Required lesson material and knowledge check publication
                  pending
                </small>
              </li>
            ))}
          </ol>
        </section>
        <aside className="purchase-card">
          <small>One-time payment</small>
          <strong>{formatCentavos(69900)}</strong>
          <p>
            Lifetime access from approval, subject to finalized published terms.
          </p>
          <Link className="button full" to="/checkout/logistics-101">
            Continue to checkout
          </Link>
          <p className="fine">
            Payment is reviewed manually and may take up to 24 hours. Approval
            is not instant.
          </p>
        </aside>
      </div>
    </div>
  );
}

function About() {
  return (
    <div className="page">
      <PageMeta
        title="About Angela"
        description="Meet Angela Valiente, trainer and operator of Logistics VA Training Academy."
      />
      <div className="profile-layout">
        <div>
          <p className="eyebrow">Experience turned into a clear path</p>
          <h1>Meet Angela Valiente.</h1>
          <p className="lede">
            Angela is a Davao City-based logistics professional helping
            beginners understand the real workflows behind remote logistics
            work.
          </p>
          <section className="prose">
            <h2>Eight years across the shipment lifecycle</h2>
            <p>
              Angela began in carrier sales and progressed through logistics
              coordination, customer success, account management and logistics
              quality analysis within major U.S. logistics companies. Logistics
              VA Training Academy translates that client-provided industry
              experience into structured, practical learning for beginners and
              career shifters.
            </p>
            <p>
              The academy does not promise jobs or income. Its role is to teach
              foundational knowledge, operational vocabulary and workflows
              students can continue building on.
            </p>
          </section>
        </div>
        <figure className="profile-photo">
          <img
            src="/headshot.jpg"
            alt="Angela Valiente, Logistics VA Training Academy trainer"
          />
        </figure>
      </div>
    </div>
  );
}

function Faq() {
  const items = [
    [
      "Do I need experience?",
      "No. Logistics 101 is designed for beginners and career shifters.",
    ],
    [
      "Is learning self-paced?",
      "Yes. Approved learners work through the course at their own pace.",
    ],
    [
      "Which languages are available?",
      "English and Bisaya are planned. Missing translations will be labeled rather than silently substituted.",
    ],
    [
      "How long is payment verification?",
      "Manual verification may take up to 24 hours. A proof upload alone does not grant access.",
    ],
    [
      "Which payment methods are accepted?",
      "GCash and MariBank are accepted through their verified QR codes. Confirm the displayed recipient and exact order amount before sending.",
    ],
    [
      "How do I earn a certificate?",
      "Complete every required module and knowledge check, then pass the final quiz at 75%. Final retries are unlimited with no waiting period.",
    ],
  ];
  return (
    <div className="page narrow">
      <PageMeta
        title="Frequently asked questions"
        description="Answers about Logistics 101 access, payment, language and certificates."
      />
      <p className="eyebrow">Questions, answered</p>
      <h1>Before you enroll.</h1>
      <div className="faq-list">
        {items.map(([q, a]) => (
          <details key={q}>
            <summary>{q}</summary>
            <p>{a}</p>
          </details>
        ))}
      </div>
    </div>
  );
}

function Contact() {
  return (
    <div className="page narrow">
      <PageMeta
        title="Contact"
        description="Contact Logistics VA Training Academy by email, phone or Facebook."
      />
      <p className="eyebrow">Student support</p>
      <h1>Talk with the academy.</h1>
      <div className="contact-list">
        <a href="mailto:Anjval27@gmail.com">
          <span>Email</span>Anjval27@gmail.com
        </a>
        <a href="tel:+639633442176">
          <span>Phone</span>+63 963 344 2176
        </a>
        <a
          href="https://www.facebook.com/angela.arana.33/"
          target="_blank"
          rel="noreferrer"
        >
          <span>Facebook</span>Angela Valiente
        </a>
      </div>
    </div>
  );
}

const policyCopy: Record<string, { title: string; body: string }> = {
  privacy: {
    title: "Privacy notice",
    body: "This development draft describes account, enrollment, payment-proof and learning records needed to operate the academy. Final retention, processor and data-subject wording requires owner review.",
  },
  terms: {
    title: "Terms of use",
    body: "This development draft describes account conduct, course access and assessment rules. Lifetime access wording, effective date and final legal terms require owner approval.",
  },
  payment: {
    title: "Payment policy",
    body: "GCash and MariBank payments are made outside the platform through the verified QR destination shown at checkout. Confirm the recipient and exact order amount before sending. Proof and transaction details are uploaded privately and reviewed manually against actual receipt. Verification may take up to 24 hours; uploading proof does not itself grant access.",
  },
  refund: {
    title: "Refund policy",
    body: "Draft criteria include a request within three days, less than 20% progress, and no material download, final attempt or certificate. Decisions are manually reviewed; approved external returns are expected to take 7–14 business days. This is not an automatic eligibility promise.",
  },
  certificate: {
    title: "Certificate policy",
    body: "A certificate requires completion of all required modules and a passing final quiz. Verification exposes limited certificate details. Correction, revocation and signature rules require final owner approval.",
  },
  disclaimer: {
    title: "Learning disclaimer",
    body: "Training does not guarantee employment, placement, earnings or a particular career result. No accreditation claim is made.",
  },
};
function Policy() {
  const { type = "terms" } = useParams();
  const copy = policyCopy[type] ?? policyCopy.terms;
  return (
    <div className="page narrow">
      <PageMeta
        title={copy.title}
        description={`${copy.title} for Logistics VA Training Academy.`}
      />
      <div className="draft-banner">
        Development draft · not approved for publication · effective date
        pending
      </div>
      <h1>{copy.title}</h1>
      <div className="prose">
        <p>{copy.body}</p>
        <p>
          Questions may be sent to{" "}
          <a href="mailto:anjval27@gmail.com">anjval27@gmail.com</a>. Davao
          City, Philippines is the proposed jurisdiction/contact location,
          subject to final review.
        </p>
      </div>
    </div>
  );
}

const registerSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email(),
  password: z
    .string()
    .min(8)
    .regex(/[A-Za-z]/, "Include at least one letter.")
    .regex(/\d/, "Include at least one number."),
  language: z.enum(["en", "ceb"]),
  adult: z.literal(true, { error: "You must confirm you are at least 18." }),
  policies: z.literal(true, {
    error: "You must accept the draft terms and privacy notice.",
  }),
});
type RegisterInput = z.infer<typeof registerSchema>;
function Register() {
  const navigate = useNavigate();
  const [message, setMessage] = useState("");
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RegisterInput>({
    resolver: zodResolver(registerSchema),
    defaultValues: { language: "en" },
  });
  const submit = async (values: RegisterInput) => {
    setMessage("");
    if (!isSupabaseConfigured) {
      setMessage(
        "Registration is unavailable until the test Supabase environment is configured.",
      );
      return;
    }
    const redirectTo = `${appOrigin}/auth/callback`;
    const { data, error } = await supabase.auth.signUp({
      email: values.email,
      password: values.password,
      options: {
        emailRedirectTo: redirectTo,
        data: {
          full_name: values.fullName,
          preferred_language: values.language,
          age_18_attested: true,
          terms_version: draftPolicyVersion,
          privacy_version: draftPolicyVersion,
        },
      },
    });
    if (error) {
      setMessage(registrationErrorMessage(error));
      return;
    }
    if (data.session) {
      const role = await supabase.rpc("is_admin");
      navigate(signedInDestination(!role.error && role.data === true), {
        replace: true,
      });
      return;
    }
    setMessage(
      registrationSuccessMessage(data.user?.identities?.length),
    );
  };
  return (
    <AuthShell title="Create your student account">
      <form onSubmit={handleSubmit(submit)} noValidate>
        <Field label="Full name" error={errors.fullName?.message}>
          <input autoComplete="name" {...register("fullName")} />
        </Field>
        <Field label="Email" error={errors.email?.message}>
          <input type="email" autoComplete="email" {...register("email")} />
        </Field>
        <Field
          label="Password"
          hint="At least 8 characters with a letter and a number"
          error={errors.password?.message}
        >
          <input
            type="password"
            autoComplete="new-password"
            {...register("password")}
          />
        </Field>
        <Field label="Preferred language">
          <select {...register("language")}>
            <option value="en">English</option>
            <option value="ceb">Bisaya</option>
          </select>
        </Field>
        <label className="check">
          <input type="checkbox" {...register("adult")} /> I confirm I am at
          least 18 years old.
        </label>
        {errors.adult && <p className="error">{errors.adult.message}</p>}
        <label className="check">
          <input type="checkbox" {...register("policies")} /> I acknowledge the
          development-draft terms and privacy notice.
        </label>
        {errors.policies && <p className="error">{errors.policies.message}</p>}
        <button className="button full" disabled={isSubmitting}>
          {isSubmitting ? "Creating account…" : "Create account"}
        </button>
        <Status>{message}</Status>
      </form>
      <p className="auth-switch">
        Already registered? <Link to="/login">Sign in</Link>
      </p>
    </AuthShell>
  );
}

function AuthShell({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="auth-page">
      <PageMeta title={title} description={title} noIndex />
      <div className="auth-card">
        <p className="eyebrow">Student portal</p>
        <h1>{title}</h1>
        {children}
      </div>
    </div>
  );
}

function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!isSupabaseConfigured) {
      setMessage("Sign in is unavailable until Supabase is configured.");
      return;
    }
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) {
      setMessage(
        "Email or password was not accepted. Verify your email or reset your password.",
      );
      return;
    }
    const role = await supabase.rpc("is_admin");
    navigate(signedInDestination(!role.error && role.data === true), {
      replace: true,
    });
  };
  return (
    <AuthShell title="Welcome back">
      <form onSubmit={submit}>
        <Field label="Email">
          <input
            required
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Password">
          <input
            required
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <button className="button full">Sign in</button>
        <Status>{message}</Status>
      </form>
      <div className="auth-switch">
        <Link to="/forgot-password">Forgot password?</Link> ·{" "}
        <Link to="/register">Create account</Link>
      </div>
    </AuthShell>
  );
}
function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!emailDeliveryEnabled) {
      setMessage(
        "Password recovery email is unavailable in this development/test environment. Contact the academy administrator for test-account assistance.",
      );
      return;
    }
    if (isSupabaseConfigured)
      await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${appOrigin}/reset-password`,
      });
    setMessage(
      "If an eligible account exists, recovery instructions will be sent. Check your inbox and spam folder.",
    );
  };
  return (
    <AuthShell title="Reset your password">
      {!emailDeliveryEnabled && (
        <div className="notice">
          Password recovery email is unavailable until outbound email delivery
          is configured and verified.
        </div>
      )}
      <form onSubmit={submit}>
        <Field label="Email">
          <input
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <button className="button full" disabled={!emailDeliveryEnabled}>
          Send recovery link
        </button>
        <Status>{message}</Status>
      </form>
    </AuthShell>
  );
}
function ResetPassword() {
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 8) {
      setMessage("Use at least 8 characters.");
      return;
    }
    const { error } = await supabase.auth.updateUser({ password });
    setMessage(
      error
        ? "This recovery link may be expired or invalid. Request a new one."
        : "Password updated. You can now continue to your dashboard.",
    );
  };
  return (
    <AuthShell title="Choose a new password">
      <form onSubmit={submit}>
        <Field label="New password">
          <input
            required
            minLength={8}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <button className="button full">Update password</button>
        <Status>{message}</Status>
      </form>
    </AuthShell>
  );
}
function AuthCallback() {
  const { loading, adminLoading, session, isAdmin } = useAuth();
  if (loading || adminLoading) return <Loading />;
  return (
    <Navigate replace to={session ? signedInDestination(isAdmin) : "/login"} />
  );
}

function Protected({ admin = false }: { admin?: boolean }) {
  const { session, loading, adminLoading, isAdmin } = useAuth();
  const location = useLocation();
  if (loading || (admin && session && adminLoading)) return <Loading />;
  if (!session)
    return <Navigate replace to="/login" state={{ from: location.pathname }} />;
  if (admin && !isAdmin) return <Navigate replace to="/dashboard" />;
  return <Outlet />;
}

type Order = {
  id: string;
  price_centavos: number;
  currency: string;
  status: string;
  created_at: string;
};
type Submission = {
  id: string;
  order_id: string;
  status: string;
  reference_number: string;
  submitted_amount_centavos: number;
  created_at: string;
  review_reason: string | null;
};
type PaymentHistory = { orders: Order[]; submissions: Submission[] };

function Dashboard() {
  const { session } = useAuth();
  // Access is granted by an administrator, so the dashboard reads the student's
  // own enrollment rows rather than inferring access from the payment history.
  const { courses: enrolledCourses, loading: coursesLoading } = useEnrolledCourses();

  const paymentFetcher = useCallback(async () => {
    const [orderResult, submissionResult] = await Promise.all([
      supabase
        .from("orders")
        .select("id,price_centavos,currency,status,created_at")
        .order("created_at", { ascending: false }),
      supabase
        .from("payment_submissions")
        .select(
          "id,order_id,status,reference_number,submitted_amount_centavos,created_at,review_reason",
        )
        .order("created_at", { ascending: false }),
    ]);
    const failure = orderResult.error ?? submissionResult.error;
    return {
      value: {
        orders: (orderResult.data ?? []) as Order[],
        submissions: (submissionResult.data ?? []) as Submission[],
      },
      error: failure?.message ?? "",
    };
  }, []);

  // Both loaders refresh on focus: an administrator can approve a payment from
  // another tab, and the student should see the course when they return here.
  const {
    value: payments,
    error: paymentsError,
    loading: paymentsLoading,
  } = useResource<PaymentHistory>(paymentFetcher, { orders: [], submissions: [] }, {
    refreshOnFocus: true,
  });

  const { orders, submissions } = payments;
  const loading = paymentsLoading || coursesLoading;

  const logout = async () => {
    await supabase.auth.signOut();
  };
  return (
    <div className="page">
      <PageMeta
        title="Student dashboard"
        description="Your Logistics VA Training Academy account."
        noIndex
      />
      <div className="page-heading">
        <div>
          <p className="eyebrow">Student dashboard</p>
          <h1>Your learning desk.</h1>
          <p>{session?.user.email}</p>
        </div>
        <button className="secondary" onClick={logout}>
          Sign out
        </button>
      </div>
      {loading || coursesLoading ? (
        <Loading />
      ) : (
        <>
          {paymentsError && <Status>{paymentsError}</Status>}
          <section className="dashboard-card">
            <h2>Your courses</h2>
            {enrolledCourses.length === 0 ? (
              <div className="empty">
                <p>
                  You do not have an active enrollment yet. Access appears here only
                  after an administrator approves your payment proof or grants an
                  audited manual enrollment.
                </p>
                <Link className="button" to="/checkout/logistics-101">
                  Payment and checkout
                </Link>
              </div>
            ) : (
              <div className="table-list">
                {enrolledCourses.map((row) => {
                  // Ownership and availability are reported separately. Being
                  // enrolled with nothing published yet is a real state and is
                  // described rather than rendered as an empty course.
                  const nothingPublished = row.published_modules === 0;
                  return (
                    <article key={row.enrollment.id}>
                      <div>
                        <strong>{row.courseTitle}</strong>
                        <p>
                          Active since {formatManilaDateTime(row.enrollment.granted_at)}
                        </p>
                        <p>
                          {nothingPublished
                            ? "Your access is active, but no lessons are published yet"
                            : `${row.published_modules} module${
                                row.published_modules === 1 ? "" : "s"
                              } available · ${row.required_modules} required`}
                        </p>
                        {row.knowledge_checks > 0 && (
                          <p>{row.knowledge_checks} knowledge checks</p>
                        )}
                      </div>
                      <div>
                        <Link className="button" to={`/learn/${row.courseId}`}>
                          {nothingPublished ? "View course status" : "Continue learning"}
                        </Link>
                        {row.certificate?.status === "active" && (
                          <p>
                            <Link
                              className="text-link"
                              to={`/verify/${row.certificate.verification_id}`}
                            >
                              View certificate
                            </Link>
                          </p>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
          <section>
            <h2>Payment history</h2>
            {submissions.length === 0 ? (
              <div className="empty">No payment proof submitted yet.</div>
            ) : (
              <div className="table-list">
                {submissions.map((item) => (
                  <article key={item.id}>
                    <div>
                      <strong>{item.status.replace("_", " ")}</strong>
                      <p>Reference {item.reference_number}</p>
                    </div>
                    <div>
                      {formatCentavos(item.submitted_amount_centavos)}
                      <small>
                        {new Date(item.created_at).toLocaleString("en-PH", {
                          timeZone: "Asia/Manila",
                        })}
                      </small>
                    </div>
                    {item.review_reason && <p>{item.review_reason}</p>}
                  </article>
                ))}
              </div>
            )}
            <p className="fine">
              {orders.length} order record{orders.length === 1 ? "" : "s"}{" "}
              associated with this account.
            </p>
          </section>
        </>
      )}
    </div>
  );
}

type PaymentMethod = {
  id: string;
  type: string;
  display_name: string;
  destination_label: string;
  destination_details: string;
  instructions: string;
  qr_object_path: string | null;
};
function Checkout() {
  const { session } = useAuth();
  const [order, setOrder] = useState<Order | null>(null);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [selectedMethodId, setSelectedMethodId] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    if (!session) return;
    void (async () => {
      const { data, error } = await supabase.rpc("create_order", {
        course_slug: "logistics-101",
      });
      if (error) {
        setMessage(error.message);
        return;
      }
      setOrder(data as Order);
      const methodResult = await supabase
        .from("payment_methods")
        .select(
          "id,type,display_name,destination_label,destination_details,instructions,qr_object_path",
        )
        .eq("enabled", true)
        .order("display_name");
      setMethods((methodResult.data ?? []) as PaymentMethod[]);
    })();
  }, [session]);
  const selectedMethod = methods.find(
    (method) => method.id === selectedMethodId,
  );
  const qrUrl = selectedMethod?.qr_object_path
    ? supabase.storage
        .from("branding")
        .getPublicUrl(selectedMethod.qr_object_path).data.publicUrl
    : null;
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!order) return;
    const form = new FormData(e.currentTarget);
    const proof = form.get("proof");
    if (!(proof instanceof File)) {
      setMessage("Choose a payment proof file.");
      return;
    }
    const validationError = validateProofFile(proof);
    if (validationError) {
      setMessage(validationError);
      return;
    }
    setSubmitting(true);
    setMessage("");
    form.set("orderId", order.id);
    form.set("amountCentavos", String(order.price_centavos));
    const { data, error } = await supabase.functions.invoke(
      "submit-payment-proof",
      { body: form },
    );
    setSubmitting(false);
    setMessage(
      error
        ? error.message || "Upload failed. Your access has not changed."
        : `Proof received as ${String((data as { status?: string })?.status ?? "pending")}. Upload does not grant access.`,
    );
    if (!error) e.currentTarget.reset();
  };
  return (
    <div className="page narrow">
      <PageMeta
        title="Logistics 101 checkout"
        description="Submit payment proof for Logistics 101."
        noIndex
      />
      <p className="eyebrow">Secure manual checkout</p>
      <h1>Payment and proof.</h1>
      <div className="notice">
        <strong>
          Pay only through the verified GCash or MariBank destination shown below.
        </strong>{" "}
        Confirm the recipient and exact amount in your payment app before
        sending. The academy contact number is not a payment destination.
      </div>
      {message && <Status>{message}</Status>}
      {order && methods.length > 0 ? (
        <form className="checkout-form" onSubmit={submit}>
          <div className="amount">
            <span>Exact amount due</span>
            <strong>{formatCentavos(order.price_centavos)}</strong>
            <small>Order {order.id}</small>
          </div>
          <Field label="Payment method">
            <select
              name="methodId"
              required
              value={selectedMethodId}
              onChange={(event) => setSelectedMethodId(event.target.value)}
            >
              <option value="" disabled>
                Select a verified method
              </option>
              {methods.map((method) => (
                <option key={method.id} value={method.id}>
                  {method.display_name} — {method.destination_label}:{" "}
                  {method.destination_details}
                </option>
              ))}
            </select>
          </Field>
          {selectedMethod && (
            <section className="payment-destination" aria-live="polite">
              <div>
                <small>{selectedMethod.destination_label}</small>
                <strong>{selectedMethod.destination_details}</strong>
                <p>{selectedMethod.instructions}</p>
              </div>
              {qrUrl && (
                <img
                  src={qrUrl}
                  alt={`${selectedMethod.display_name} payment QR code`}
                />
              )}
            </section>
          )}
          <Field label="Reference number">
            <input
              required
              name="referenceNumber"
              minLength={3}
              maxLength={100}
            />
          </Field>
          <Field label="Payment date and time">
            <input required name="transactionAt" type="datetime-local" />
          </Field>
          <Field
            label="Payment proof"
            hint="JPG, PNG or PDF up to 10 MB. Contents are checked server-side."
          >
            <input
              required
              name="proof"
              type="file"
              accept="image/jpeg,image/png,application/pdf"
            />
          </Field>
          <button className="button full" disabled={submitting}>
            {submitting
              ? "Validating and uploading…"
              : "Submit proof for review"}
          </button>
        </form>
      ) : (
        <div className="empty">
          <h2>Checkout is not enabled</h2>
          <p>
            Do not transfer funds based on contact details or QR codes shared
            outside this checkout.
          </p>
        </div>
      )}
    </div>
  );
}

type VerificationResult = {
  status: "valid" | "revoked" | "not_found";
  verificationId?: string;
  studentName?: string;
  courseTitle?: string;
  completedAt?: string;
  issuedAt?: string;
};
function Verify() {
  const { certificateId = "" } = useParams();
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(
      `${supabaseUrl}/functions/v1/verify-certificate?id=${encodeURIComponent(certificateId)}`,
      {
        headers: { apikey: supabasePublishableKey },
        signal: controller.signal,
      },
    )
      .then(async (response) => {
        const payload = await response
          .json()
          .catch(() => ({ status: "not_found" }));
        setResult(payload as VerificationResult);
        setLoading(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setResult({ status: "not_found" });
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [certificateId]);
  return (
    <div className="page narrow">
      <PageMeta
        title="Certificate verification"
        description="Verify a Logistics VA Training Academy certificate."
      />
      <p className="eyebrow">Public verification</p>
      <h1>Certificate lookup.</h1>
      {loading ? (
        <Loading label="Checking certificate…" />
      ) : (
        <div className="empty">
          {result?.status === "valid" ? (
            <>
              <h2>Valid certificate</h2>
              <p>
                <strong>{result.studentName}</strong> completed{" "}
                {result.courseTitle}.
              </p>
              <p>
                Completed{" "}
                {result.completedAt
                  ? new Date(result.completedAt).toLocaleDateString("en-PH", {
                      timeZone: "Asia/Manila",
                      dateStyle: "long",
                    })
                  : "date unavailable"}{" "}
                · Issued{" "}
                {result.issuedAt
                  ? new Date(result.issuedAt).toLocaleDateString("en-PH", {
                      timeZone: "Asia/Manila",
                      dateStyle: "long",
                    })
                  : "date unavailable"}
              </p>
              <small>{result.verificationId}</small>
            </>
          ) : result?.status === "revoked" ? (
            <>
              <h2>Revoked certificate</h2>
              <p>
                This identifier is authentic but is no longer valid. Contact the
                academy for support.
              </p>
              <small>{result.verificationId}</small>
            </>
          ) : (
            <>
              <h2>Certificate not found</h2>
              <p>No public certificate matches this identifier.</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
function NotFound() {
  return (
    <div className="page narrow">
      <PageMeta
        title="Page not found"
        description="The requested page was not found."
        noIndex
      />
      <h1>That route is not on the map.</h1>
      <Link className="button" to="/">
        Return home
      </Link>
    </div>
  );
}

function AdminOverview() {
  const sections = [
    {
      to: "/admin/payments",
      title: "Payment review queue",
      body: "Decide each submitted proof and grant access in one transaction.",
    },
    {
      to: "/admin/students",
      title: "Students",
      body: "Grant manual enrollment, suspend or reinstate accounts and enrollment access.",
    },
    {
      to: "/admin/courses",
      title: "Course and modules",
      body: "Import bilingual material, publish modules and control sales.",
    },
    {
      to: "/admin/reports",
      title: "Revenue reporting",
      body: "Approved and refunded totals derived from reviewed submissions.",
    },
    {
      to: "/admin/audit",
      title: "Audit log",
      body: "Privileged actions with actor, reason and server timestamp.",
    },
  ];
  return (
    <div className="page">
      <PageMeta
        title="Administration"
        description="Private academy administration."
        noIndex
      />
      <p className="eyebrow">Administration</p>
      <h1>Academy administration.</h1>
      <p className="lede">
        Every action here is authorized by a database check on your role rather
        than by hiding a button, and each one writes an audit record with a
        required reason.
      </p>
      <div className="course-grid">
        <section>
          <h2>Where to go next</h2>
          <div className="table-list">
            {sections.map((section) => (
              <article key={section.to}>
                <div>
                  <strong>{section.title}</strong>
                  <p>{section.body}</p>
                </div>
                <Link className="secondary" to={section.to}>
                  Open
                </Link>
              </article>
            ))}
          </div>
        </section>
        <aside className="purchase-card">
          <small>Before opening enrollment</small>
          <strong>Nothing is live yet</strong>
          <p>
            Verified GCash and MariBank destinations are configured, but sales
            stay disabled until the remaining course, assessment, policy and
            launch gates pass.
          </p>
          <Link className="button full" to="/admin/courses">
            Configure the course
          </Link>
        </aside>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="about" element={<About />} />
        <Route path="courses/logistics-101" element={<Course />} />
        <Route path="faq" element={<Faq />} />
        <Route path="contact" element={<Contact />} />
        <Route path="policies/:type" element={<Policy />} />
        <Route path="verify/:certificateId" element={<Verify />} />
        <Route path="register" element={<Register />} />
        <Route path="login" element={<Login />} />
        <Route path="forgot-password" element={<ForgotPassword />} />
        <Route path="reset-password" element={<ResetPassword />} />
        <Route path="auth/callback" element={<AuthCallback />} />
        <Route element={<Protected />}>
          <Route path="dashboard" element={<Dashboard />} />
          <Route
            path="dashboard/payments"
            element={<Navigate replace to="/dashboard" />}
          />
          <Route
            path="dashboard/payments/:id"
            element={<Navigate replace to="/dashboard" />}
          />
          <Route path="payments/:id/resubmit" element={<StudentResubmit />} />
          <Route path="learn/:courseId" element={<LearnCourse />} />
          <Route
            path="learn/:courseId/modules/:moduleId"
            element={<ModuleLesson />}
          />
          <Route
            path="learn/:courseId/modules/:moduleId/quiz"
            element={<KnowledgeCheck />}
          />
          <Route path="learn/:courseId/final-quiz" element={<FinalQuiz />} />
          <Route path="checkout/logistics-101" element={<Checkout />} />
          <Route path="account" element={<Dashboard />} />
        </Route>
        <Route element={<Protected admin />}>
          <Route path="admin" element={<AdminOverview />} />
          <Route path="admin/payments" element={<AdminPayments />} />
          <Route path="admin/payments/:id" element={<AdminPaymentDetail />} />
          <Route path="admin/students" element={<AdminStudents />} />
          <Route path="admin/reports" element={<AdminReports />} />
          <Route path="admin/audit" element={<AdminAudit />} />
          <Route path="admin/courses" element={<AdminCourses />} />
          <Route
            path="admin/courses/:moduleId/material"
            element={<AdminCourseMaterial />}
          />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
