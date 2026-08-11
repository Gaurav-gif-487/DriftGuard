package main

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

type OrderStatus struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

func getOrderStatus(c *gin.Context) {
	c.JSON(http.StatusOK, OrderStatus{ID: "123", Status: "shipped"})
}

func main() {
	router := gin.Default()
	// Renamed from "orderstatus" to "order-status" — the client
	// (fixtures/frontend/src/api/orderStatusClient.ts) still concatenates
	// the old segment, so this can only be resolved via fuzzy matching.
	router.GET("/api/v2/order-status/:id", getOrderStatus)
	router.Run()
}
