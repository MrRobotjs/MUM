//go:build !migrationtool

package main

import (
	"context"
	"embed"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

//go:embed dist/*
var frontendFiles embed.FS

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "MUM:", err)
		waitBeforeClosing(os.Stdin, os.Stdout, launchedByDoubleClick())
		os.Exit(1)
	}
}
func run() error {
	dataDir := flag.String("data-dir", "", "writable application data directory (default: MUM_DATA_DIR, else the user config directory)")
	listen := flag.String("listen", "", "HTTP listen address (default: MUM_LISTEN, else "+runtimeConfigFile+", else 127.0.0.1:5699)")
	secureCookies := flag.Bool("secure-cookies", false, "mark cookies Secure even without detected HTTPS (default: MUM_SECURE_COOKIES or "+runtimeConfigFile+")")
	trustedProxies := flag.String("trusted-proxies", "", "comma-separated reverse proxy IPs/CIDRs whose X-Forwarded-* headers are trusted")
	recoverOwner := flag.Bool("recover-owner", false, "recover existing local owner credentials offline (interactive terminal required)")
	showVersion := flag.Bool("version", false, "print the version and exit")
	logLevel := flag.String("log-level", os.Getenv("MUM_LOG_LEVEL"), "console log level: debug, info (default), warn or error; overrides MUM_LOG_LEVEL")
	flag.Parse()
	if flag.NArg() != 0 {
		return errors.New("positional arguments are not supported")
	}
	if *showVersion {
		fmt.Println(versionLine())
		return nil
	}
	logger, err := newConsoleLogger(os.Stderr, *logLevel)
	if err != nil {
		return err
	}
	slog.SetDefault(logger)
	logger.Info("MUM starting", "version", versionLine())
	explicitDirectory, serverOptions := false, false
	flags := runtimeFlags{}
	flag.Visit(func(f *flag.Flag) {
		switch f.Name {
		case "data-dir":
			explicitDirectory = true
		case "listen":
			serverOptions, flags.Listen = true, listen
		case "secure-cookies":
			serverOptions, flags.SecureCookies = true, secureCookies
		case "trusted-proxies":
			serverOptions, flags.TrustedProxies = true, trustedProxies
		}
	})
	if *dataDir == "" {
		*dataDir = os.Getenv("MUM_DATA_DIR")
	}
	if *dataDir == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			return fmt.Errorf("no data directory: set --data-dir or MUM_DATA_DIR (%w)", err)
		}
		*dataDir = filepath.Join(base, "MUM")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if *recoverOwner {
		if !explicitDirectory || serverOptions {
			return errors.New("use --recover-owner with an explicit --data-dir and no server options")
		}
		return runOwnerRecovery(ctx, *dataDir, os.Stdin, os.Stdout)
	}
	store, err := OpenStore(ctx, filepath.Join(*dataDir, "mum.sqlite"))
	if err != nil {
		return err
	}
	defer store.Close()
	// Loaded after the store has locked the data directory, so the first-run
	// settings file is created once.
	settings, err := loadRuntimeConfig(*dataDir, os.Getenv, flags)
	if err != nil {
		return err
	}
	queue, err := NewLogQueue(store, QueueOptions{})
	if err != nil {
		return err
	}
	defer func() { _ = queue.Shutdown(context.Background()) }()
	assets, err := fs.Sub(frontendFiles, "dist")
	if err != nil {
		return err
	}
	app, err := NewApp(store, queue, assets)
	if err != nil {
		return err
	}
	app.SecureCookies = settings.SecureCookies
	app.TrustedProxies = settings.TrustedProxies
	defer app.CloseProvisioning()
	defer app.CloseCatalogue()
	defer app.CloseScheduler()
	defer app.CloseRealtime()
	listener, err := net.Listen("tcp", settings.Listen)
	if err != nil {
		return listenError(settings.Listen, filepath.Join(*dataDir, runtimeConfigFile), err)
	}
	server := &http.Server{Handler: app, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 1 << 20}
	if err := app.StartScheduler(); err != nil {
		_ = listener.Close()
		return err
	}
	app.logActivityMonitorInventory(ctx)
	failures := make(chan error, 1)
	go func() { failures <- server.Serve(listener) }()
	fmt.Printf("MUM dashboard: %s\nData directory: %s\n", dashboardURL(listener.Addr()), *dataDir)
	logger.Info("HTTP server ready", "listen", listener.Addr().String())
	var serveErr error
	select {
	case <-ctx.Done():
	case serveErr = <-failures:
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	logger.Info("Shutdown started; stopping producers and draining accepted logs")
	defer cancel()
	// Stop socket producers explicitly: HTTP Shutdown does not own hijacked sockets.
	app.StopScheduler()
	app.CloseRealtime()
	app.StopProvisioning()
	app.StopCatalogue()
	httpErr := server.Shutdown(shutdownCtx)
	if httpErr != nil {
		_ = server.Close()
	}
	schedulerErr := app.WaitScheduler(shutdownCtx)
	queueErr := queue.Shutdown(shutdownCtx)
	if errors.Is(serveErr, http.ErrServerClosed) {
		serveErr = nil
	}
	err = errors.Join(serveErr, httpErr, schedulerErr, queueErr)
	if err != nil {
		logger.Error("Shutdown incomplete", "code", consoleErrorCode(err), "pending_logs", queue.Stats().Pending)
	} else {
		logger.Info("Shutdown completed", "pending_logs", queue.Stats().Pending)
	}
	return err
}

// dashboardURL is the address to open on this machine. A wildcard listener
// (0.0.0.0 or [::]) is also reachable from other devices, port forwarding or
// a reverse proxy; locally it is opened through localhost.
func dashboardURL(addr net.Addr) string {
	tcp, ok := addr.(*net.TCPAddr)
	if !ok {
		return "http://" + addr.String()
	}
	if tcp.IP == nil || tcp.IP.IsUnspecified() {
		return fmt.Sprintf("http://localhost:%d (listening on all network interfaces)", tcp.Port)
	}
	return "http://" + addr.String()
}
